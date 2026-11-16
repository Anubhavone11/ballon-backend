const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();
const Order = require('../models/Order');
const Counter = require('../models/Counter');
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const commissionController = require('./commissionController');
const validateSchedule = require('../utils/validateSchedule');
const { emit } = require('../notifications');
const {
  sendOrderConfirmationEmail,
  sendOrderConfirmationWhatsApp,
  sanitizeItems,
  checkAvailability,
} = require('./orderController');

// ---------------------------------------------------------------------------
// PhonePe plumbing
// ---------------------------------------------------------------------------
const phonePeEnv = () => process.env.PHONEPE_ENV || 'sandbox';
const pgBase = () =>
  phonePeEnv() === 'production'
    ? 'https://api.phonepe.com/apis/pg'
    : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

// Cache for the OAuth token (one fetch shared by concurrent requests)
let oauthToken = null;
let tokenExpiry = null;
let tokenPromise = null;

async function fetchPhonePeToken() {
  const clientId = process.env.PHONEPE_CLIENT_ID;
  const clientSecret = process.env.PHONEPE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PhonePe OAuth credentials not configured');
  }

  const oauthUrl =
    phonePeEnv() === 'production'
      ? 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token';

  console.log('Getting PhonePe OAuth token from:', oauthUrl);

  try {
    const response = await axios.post(
      oauthUrl,
      new URLSearchParams({
        client_id: clientId,
        client_version: '1',
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    if (!response.data || !response.data.access_token) {
      throw new Error('Invalid OAuth response from PhonePe');
    }

    oauthToken = response.data.access_token;
    // expires_at is in seconds; keep a 60 second safety margin
    tokenExpiry = response.data.expires_at
      ? new Date(response.data.expires_at * 1000 - 60 * 1000)
      : new Date(Date.now() + 55 * 60 * 1000);

    console.log('PhonePe OAuth token obtained, expires at:', tokenExpiry);
    return oauthToken;
  } catch (error) {
    console.error('PhonePe OAuth token error:', error.response?.data || error.message);
    if (error.response?.data?.code === 'INVALID_CLIENT') {
      throw new Error(
        'PhonePe credentials are invalid. Check PHONEPE_CLIENT_ID and PHONEPE_CLIENT_SECRET (and that PHONEPE_ENV matches them).'
      );
    }
    throw new Error('Failed to get PhonePe OAuth token');
  }
}

async function getPhonePeToken() {
  if (oauthToken && tokenExpiry && new Date() < tokenExpiry) return oauthToken;
  if (!tokenPromise) {
    tokenPromise = fetchPhonePeToken().finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

// Calls a PhonePe API. If the token was revoked (401), fetches a new one and retries once.
async function callPhonePe({ method, url, data, timeout = 15000 }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getPhonePeToken();
    try {
      return await axios({
        method,
        url,
        data,
        timeout,
        headers: { 'Content-Type': 'application/json', Authorization: `O-Bearer ${token}` },
      });
    } catch (err) {
      if (err.response?.status === 401 && attempt === 0) {
        oauthToken = null;
        tokenExpiry = null;
        continue;
      }
      throw err;
    }
  }
  return null; // unreachable
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const newMerchantOrderId = () => `MT${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

const cleanKey = (k) =>
  typeof k === 'string' && k.length >= 8 && k.length <= 100 ? k : null;

// Finds an order from any PhonePe id. Only DEFINED ids are used: a query like
// { transactionId: undefined } would match every order that has no transactionId.
const findOrderByPhonePeIds = (...ids) => {
  const list = ids.filter(Boolean).map(String);
  if (!list.length) return Promise.resolve(null);
  return Order.findOne({
    $or: [
      { phonepeMerchantOrderId: { $in: list } },
      { phonepeMerchantOrderIds: { $in: list } },
      { transactionId: { $in: list } },
    ],
  });
};

// Amount PhonePe says was paid (in paise) vs what this order expects
const amountMatches = (order, paidPaise) => {
  const paid = Number(paidPaise);
  if (!Number.isFinite(paid) || paid <= 0) return true; // PhonePe did not send an amount
  const expectedRupees = order.paymentMethod === 'cod' ? Number(order.upfrontAmount) : Number(order.totalAmount);
  const expected = Math.round(expectedRupees * 100);
  if (!Number.isFinite(expected) || expected <= 0) return true;
  return Math.abs(paid - expected) <= 100; // 1 rupee tolerance
};

// Failure from PhonePe while starting a payment. 503 tells the frontend it is safe to retry.
const upstreamFailure = (error) => {
  const status = error.response?.status;
  console.error('PhonePe API error:', status, error.response?.data || error.message);
  if (!error.response || status === 429 || status >= 500) {
    return {
      status: 503,
      body: { success: false, message: 'The payment service is busy. Please try again in a moment.' },
    };
  }
  return {
    status: 502,
    body: { success: false, message: 'We could not start the payment. Please try again or contact support.' },
  };
};

// ---------------------------------------------------------------------------
// Start a payment
// ---------------------------------------------------------------------------
// Never throws: always returns { status, body }
async function initiatePayment(body) {
  try {
    const {
      amount,
      customerName,
      email,
      phone,
      address, // object, or a street string
      city,
      pincode,
      country,
      items,
      addOns,
      shippingCost,
      codExtraCharge,
      finalTotal,
      paymentMethod,
      upfrontAmount,
      remainingAmount,
      sellerToken,
      couponCode,
      scheduledDelivery,
      idempotencyKey,
    } = body;

    const frontendUrl = process.env.FRONTEND_URL;
    const backendUrl = process.env.BACKEND_URL;

    if (!process.env.PHONEPE_CLIENT_ID || !process.env.PHONEPE_CLIENT_SECRET) {
      console.error('PhonePe credentials not configured');
      return { status: 500, body: { success: false, message: 'Payment gateway not configured. Please contact support.' } };
    }
    if (!frontendUrl || !backendUrl) {
      console.error('URL configuration missing:', { frontendUrl: !!frontendUrl, backendUrl: !!backendUrl });
      return { status: 500, body: { success: false, message: 'Application configuration missing. Please contact support.' } };
    }

    // ---- Validate input ----
    const payAmount = Number(amount);
    if (!Number.isFinite(payAmount) || payAmount <= 0) {
      return { status: 400, body: { success: false, message: 'Invalid amount provided' } };
    }

    // Email is optional (the checkout form marks it optional)
    if (!customerName || !phone) {
      return { status: 400, body: { success: false, message: 'Customer details are required' } };
    }
    const cleanEmail = email ? String(email).trim() : '';

    // The amount charged must match what the order says
    const isCod = paymentMethod === 'cod';
    const expected = isCod ? Number(upfrontAmount) : Number(finalTotal);
    if (Number.isFinite(expected) && Math.abs(expected - payAmount) > 0.5) {
      return { status: 400, body: { success: false, message: 'The payment amount does not match your order. Please refresh and try again.' } };
    }

    if (scheduledDelivery) {
      const scheduleError = validateSchedule(scheduledDelivery);
      if (scheduleError) return { status: 400, body: { success: false, message: scheduleError } };
    }

    const sanitized = sanitizeItems(items);
    if (sanitized.error) return { status: 400, body: { success: false, message: sanitized.error } };
    const cleanedItems = sanitized.items;

    const cleanedAddOns = Array.isArray(addOns)
      ? addOns
          .filter((a) => a && a.name)
          .map((a) => ({
            name: String(a.name),
            price: Math.max(0, Number(a.price || 0)),
            quantity: Math.max(1, parseInt(a.quantity, 10) || 1),
            image: a.image || '',
          }))
      : [];

    // ---- Find or create the order (same idempotency key = same order) ----
    const key = cleanKey(idempotencyKey);
    let order = key ? await Order.findOne({ idempotencyKey: key }) : null;

    if (order) {
      if (order.paymentStatus === 'completed' || order.paymentStatus === 'pending_upfront') {
        // Already paid (the customer retried after paying): send them to the status page
        return {
          status: 200,
          body: {
            success: true,
            alreadyPaid: true,
            orderId: order.transactionId || order.phonepeMerchantOrderId,
            merchantOrderId: order.phonepeMerchantOrderId,
            order,
          },
        };
      }
      if (!['pending', 'failed', 'processing'].includes(order.paymentStatus)) {
        return { status: 409, body: { success: false, message: 'This order can no longer be paid. Please place a new order.' } };
      }
    } else {
      const availability = await checkAvailability(cleanedItems);
      if (!availability.ok) {
        return { status: availability.status || 409, body: { success: false, message: availability.message } };
      }

      let customOrderId;
      try {
        const orderNumber = await Counter.getNextSequence('order');
        customOrderId = `decorationcelebration${orderNumber}`;
      } catch (counterErr) {
        console.warn('Counter sequence error, using timestamp fallback:', counterErr.message);
        customOrderId = `decorationcelebration${Date.now()}`;
      }

      // Saved as "pending" BEFORE paying, so the order exists even if the browser is closed
      const doc = new Order({
        customOrderId,
        customerName,
        email: cleanEmail,
        phone,
        address:
          address && typeof address === 'object'
            ? address
            : { street: address, city: city || '', pincode: pincode || '', country: country || 'India' },
        items: cleanedItems,
        addOns: cleanedAddOns,
        totalAmount: Number(finalTotal) || payAmount,
        shippingCost: Number(shippingCost) || 0,
        codExtraCharge: Number(codExtraCharge) || 0,
        finalTotal: Number(finalTotal) || payAmount,
        paymentMethod: paymentMethod || 'online',
        paymentStatus: 'pending',
        upfrontAmount: Number(upfrontAmount) || 0,
        remainingAmount: Number(remainingAmount) || 0,
        sellerToken: sellerToken || undefined,
        couponCode: couponCode || undefined,
        scheduledDelivery: scheduledDelivery ? new Date(scheduledDelivery) : null,
        idempotencyKey: key || undefined,
      });

      try {
        order = await doc.save();
        console.log(`[createPhonePeOrder] Pending order created: ${customOrderId}`);
      } catch (saveErr) {
        // Two identical requests raced: the unique index stopped the second one
        if (key && saveErr && saveErr.code === 11000) {
          order = await Order.findOne({ idempotencyKey: key });
        }
        if (!order) throw saveErr;
      }
    }

    // ---- New payment attempt for this order ----
    // Every attempt id is remembered, so a payment made on ANY attempt finds the order.
    const merchantOrderId = newMerchantOrderId();
    await Order.updateOne(
      { _id: order._id },
      {
        $set: { phonepeMerchantOrderId: merchantOrderId, paymentStatus: 'pending' },
        $addToSet: { phonepeMerchantOrderIds: merchantOrderId },
      }
    );

    const payload = {
      merchantOrderId,
      amount: Math.round(payAmount * 100), // paise
      expireAfter: 1200, // 20 minutes
      metaInfo: {
        udf1: customerName,
        udf2: cleanEmail,
        udf3: phone,
        udf4: sellerToken || '',
        udf5: couponCode || '',
        udf6: upfrontAmount ? `upfront:${upfrontAmount}` : '',
        udf7: remainingAmount ? `remaining:${remainingAmount}` : '',
      },
      paymentFlow: {
        type: 'PG_CHECKOUT',
        message: isCod
          ? `Upfront payment ₹${upfrontAmount} for COD order ${merchantOrderId}`
          : `Payment for order ${merchantOrderId}`,
        merchantUrls: {
          redirectUrl: `${frontendUrl.replace(/\/+$/, '')}/payment/status?orderId=${merchantOrderId}`,
        },
      },
    };

    console.log(`Making PhonePe API request for order ${order.customOrderId}`);

    let response;
    try {
      response = await callPhonePe({
        method: 'post',
        url: `${pgBase()}/checkout/v2/pay`,
        data: payload,
        timeout: 15000, // shorter than the checkout's 25 second wait, so we answer first
      });
    } catch (apiErr) {
      // The order stays "pending", so the customer's retry reuses it
      return upstreamFailure(apiErr);
    }

    const result = response?.data;
    if (result && result.orderId && result.redirectUrl) {
      await Order.updateOne({ _id: order._id }, { $set: { transactionId: result.orderId } });
      order.transactionId = result.orderId;

      return {
        status: 200,
        body: {
          success: true,
          redirectUrl: result.redirectUrl,
          orderId: result.orderId,
          merchantOrderId,
          state: result.state,
          order,
        },
      };
    }

    console.error('PhonePe payment initiation failed:', result);
    await Order.updateOne({ _id: order._id, paymentStatus: 'pending' }, { $set: { paymentStatus: 'failed' } });
    return {
      status: 502,
      body: {
        success: false,
        message: 'We could not start the payment. Please try again or contact support.',
      },
    };
  } catch (error) {
    console.error('PhonePe order error:', error.response?.data || error.message);
    return { status: 500, body: { success: false, message: 'Failed to create PhonePe order' } };
  }
}

// Requests with the same idempotency key that arrive while one is still running
// wait for that one and share its answer, so a double tap can never open two payments.
const inflightPayments = new Map();

exports.createPhonePeOrder = async (req, res) => {
  const key = cleanKey(req.body?.idempotencyKey);

  try {
    if (key && inflightPayments.has(key)) {
      const shared = await inflightPayments.get(key);
      return res.status(shared.status).json(shared.body);
    }

    const run = initiatePayment(req.body || {});
    if (key) inflightPayments.set(key, run);

    try {
      const result = await run;
      return res.status(result.status).json(result.body);
    } finally {
      if (key) inflightPayments.delete(key);
    }
  } catch (error) {
    console.error('createPhonePeOrder fatal error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to create PhonePe order' });
  }
};

// ---------------------------------------------------------------------------
// Post-payment processing
// ---------------------------------------------------------------------------
// Safe to call many times (webhook, callback and status polling can all arrive together):
// the status change is one atomic step, and only the caller that wins it does the work.
const processOrderPayment = async (order, phonepeOrderId, req) => {
  try {
    // COD: the upfront payment means they now only owe the remaining amount ("pending_upfront")
    const targetStatus = order.paymentMethod === 'cod' ? 'pending_upfront' : 'completed';

    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $in: ['pending', 'failed', 'processing'] } },
      {
        $set: {
          paymentStatus: targetStatus,
          ...(phonepeOrderId ? { transactionId: String(phonepeOrderId) } : {}),
        },
      },
      { new: true }
    );

    if (!claimed) {
      const current = await Order.findById(order._id);
      console.log(
        `[processOrderPayment] Order ${order.customOrderId} already processed (status: ${current?.paymentStatus})`
      );
      // A second, different payment for an order that is already paid: needs a manual refund
      if (current && phonepeOrderId && current.transactionId && String(current.transactionId) !== String(phonepeOrderId)) {
        console.error(
          `[DUPLICATE PAYMENT] Order ${order.customOrderId} was already paid (${current.transactionId}) ` +
            `and PhonePe reports another payment (${phonepeOrderId}). Refund the extra payment.`
        );
      }
      return current || order;
    }

    console.log(`[processOrderPayment] Order ${claimed.customOrderId} marked ${targetStatus}`);

    // -- Commission --
    let seller = null;
    let commission = 0;
    if (claimed.sellerToken) {
      try {
        seller = await Seller.findOne({ sellerToken: claimed.sellerToken });
        if (seller) {
          const commissionRate = 0.30;
          commission = Number(claimed.totalAmount) * commissionRate;
          await commissionController.createCommissionEntry(claimed._id, seller._id, claimed.totalAmount, commissionRate);
          console.log(`[processOrderPayment] Commission entry created for seller: ${seller.businessName}`);
        }
      } catch (err) {
        console.error('[processOrderPayment] Commission error:', err);
      }
    }

    // -- Stock (atomic) --
    const stockedIds = [];
    for (const item of claimed.items) {
      if (!item.productId) continue;
      try {
        await Product.updateOne(
          { _id: item.productId, stock: { $type: 'number' } },
          { $inc: { stock: -(item.quantity || 1) } }
        );
        stockedIds.push(item.productId);
      } catch (err) {
        console.error(`[processOrderPayment] Stock update error for product ${item.productId}:`, err);
      }
    }
    if (stockedIds.length) {
      try {
        await Product.updateMany({ _id: { $in: stockedIds }, stock: { $lt: 0 } }, { $set: { stock: 0 } });
        await Product.updateMany({ _id: { $in: stockedIds }, stock: { $lte: 0 } }, { $set: { inStock: false } });
      } catch (err) {
        console.error('[processOrderPayment] Stock cleanup error:', err);
      }
    }

    // -- Notifications (never block or fail the payment) --
    sendOrderConfirmationEmail(claimed).catch((err) =>
      console.error('[processOrderPayment] Email notification failed:', err.message)
    );
    sendOrderConfirmationWhatsApp(claimed).catch((err) =>
      console.error('[processOrderPayment] WhatsApp notification failed:', err.message)
    );
    try {
      // Same event createOrder emits, so paid online bookings reach admin/seller notifications too
      emit('order.created', { order: claimed, req, seller, commission });
    } catch (err) {
      console.error('[processOrderPayment] order.created notification failed:', err.message);
    }

    return claimed;
  } catch (error) {
    console.error('[processOrderPayment] Critical error during payment processing:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// PhonePe Webhook handler
// ---------------------------------------------------------------------------
exports.phonePeWebhook = async (req, res) => {
  console.log('[phonePeWebhook] Received webhook callback');

  try {
    // 1. Verify Authorization header
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      console.warn('[phonePeWebhook] Missing Authorization header');
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const webhookUsername = process.env.PHONEPE_WEBHOOK_USERNAME;
    const webhookPassword = process.env.PHONEPE_WEBHOOK_PASSWORD;

    if (!webhookUsername || !webhookPassword) {
      console.error('[phonePeWebhook] Webhook credentials not configured in .env');
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    const expectedHash = crypto
      .createHash('sha256')
      .update(`${webhookUsername}:${webhookPassword}`)
      .digest('hex');

    const given = Buffer.from(String(authHeader).toLowerCase());
    const wanted = Buffer.from(expectedHash.toLowerCase());
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
      console.warn('[phonePeWebhook] Invalid Authorization header');
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // 2. Parse payload
    const { event, payload } = req.body || {};
    console.log('[phonePeWebhook] Event:', event);

    if (!event || !payload) {
      return res.status(400).json({ success: false, message: 'Invalid payload structure' });
    }

    const merchantOrderId = payload.merchantOrderId;
    const phonepeOrderId = payload.orderId || payload.transactionId;

    // 3. Handle events
    if (event === 'checkout.order.completed') {
      console.log(`[phonePeWebhook] Processing completed event for order: ${merchantOrderId}`);

      if (payload.state !== 'COMPLETED') {
        console.log(`[phonePeWebhook] Order state is ${payload.state}, ignoring.`);
        return res.status(200).json({ success: true, message: 'Ignored non-completed state' });
      }

      const order = await findOrderByPhonePeIds(merchantOrderId, phonepeOrderId);
      if (!order) {
        console.warn(`[phonePeWebhook] Order not found for ID: ${merchantOrderId} / ${phonepeOrderId}`);
        return res.status(404).json({ success: false, message: 'Order not found' });
      }

      if (!amountMatches(order, payload.amount)) {
        console.error(
          `[PAYMENT AMOUNT MISMATCH] Order ${order.customOrderId}: PhonePe amount ${payload.amount} paise, ` +
            `expected about ${Math.round(Number(order.paymentMethod === 'cod' ? order.upfrontAmount : order.totalAmount) * 100)}. ` +
            'Not marked as paid. Check this payment manually.'
        );
        return res.status(200).json({ success: true, message: 'Amount mismatch recorded' });
      }

      await processOrderPayment(order, phonepeOrderId, req);
      return res.status(200).json({ success: true, message: 'Webhook processed successfully' });
    }

    if (event === 'checkout.order.failed') {
      console.log(`[phonePeWebhook] Payment failed for order: ${merchantOrderId}`);
      const order = await findOrderByPhonePeIds(merchantOrderId, phonepeOrderId);
      if (order) {
        // Only an unpaid order can become "failed": a failed attempt must never undo a paid order
        await Order.updateOne({ _id: order._id, paymentStatus: 'pending' }, { $set: { paymentStatus: 'failed' } });
      }
      return res.status(200).json({ success: true, message: 'Payment failed event received' });
    }

    console.log(`[phonePeWebhook] Unhandled event type: ${event}`);
    return res.status(200).json({ success: true, message: 'Event ignored' });
  } catch (error) {
    console.error('[phonePeWebhook] Error processing webhook:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ---------------------------------------------------------------------------
// Callback (the frontend asks us to verify a payment)
// ---------------------------------------------------------------------------
exports.phonePeCallback = async (req, res) => {
  try {
    const { merchantOrderId, orderId } = req.body || {};
    console.log('PhonePe callback received:', req.body);

    if (!merchantOrderId && !orderId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid callback data: merchantOrderId or orderId required',
      });
    }

    const idToVerify = orderId || merchantOrderId;

    try {
      const response = await callPhonePe({
        method: 'get',
        url: `${pgBase()}/checkout/v2/order/${encodeURIComponent(idToVerify)}/status`,
      });

      console.log('PhonePe verification response:', response.data);

      if (response.data && response.data.state === 'COMPLETED') {
        const order = await findOrderByPhonePeIds(merchantOrderId, orderId, response.data.merchantOrderId, response.data.orderId);

        if (!order) {
          console.warn('Order not found during callback verification');
          return res.status(404).json({ success: false, message: 'Order not found' });
        }

        if (!amountMatches(order, response.data.amount)) {
          console.error(`[PAYMENT AMOUNT MISMATCH] Order ${order.customOrderId} (callback). Not marked as paid.`);
          return res.status(409).json({ success: false, message: 'Payment amount did not match. Our team will review it.' });
        }

        await processOrderPayment(order, response.data.orderId || orderId, req);
        return res.json({
          success: true,
          message: 'Payment completed successfully',
          orderId,
          status: 'COMPLETED',
        });
      }

      return res.json({
        success: false,
        message: `Payment status: ${response.data?.state || 'Unknown'}`,
        status: response.data?.state,
      });
    } catch (verifError) {
      console.error('PhonePe verification error:', verifError.response?.data || verifError.message);
      return res.status(500).json({ success: false, message: 'Verification failed' });
    }
  } catch (error) {
    console.error('PhonePe callback error:', error);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
};

// ---------------------------------------------------------------------------
// Status (the /payment/status page polls this)
// ---------------------------------------------------------------------------
exports.getPhonePeStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required' });
    }

    console.log(`Checking PhonePe status for orderId: ${orderId}`);

    const response = await callPhonePe({
      method: 'get',
      url: `${pgBase()}/checkout/v2/order/${encodeURIComponent(orderId)}/status`,
    });

    console.log('PhonePe status response:', response.data);

    const state = response.data?.state;
    const order = await findOrderByPhonePeIds(orderId, response.data?.merchantOrderId, response.data?.orderId);

    if (state === 'COMPLETED') {
      // Proactive update in case the webhook has not arrived yet
      if (order && amountMatches(order, response.data.amount)) {
        await processOrderPayment(order, response.data.orderId || orderId, req);
      } else if (order) {
        console.error(`[PAYMENT AMOUNT MISMATCH] Order ${order.customOrderId} (status check). Not marked as paid.`);
      }

      const fresh = order ? await Order.findById(order._id).select('paymentStatus customOrderId') : null;
      return res.json({
        success: true,
        data: response.data,
        paymentStatus: fresh?.paymentStatus,
        message: 'Payment completed',
      });
    }

    if (state === 'FAILED' && order) {
      await Order.updateOne({ _id: order._id, paymentStatus: 'pending' }, { $set: { paymentStatus: 'failed' } });
    }

    return res.json({
      success: false,
      data: response.data,
      paymentStatus: order?.paymentStatus,
      message: state || 'Unknown',
    });
  } catch (error) {
    console.error('PhonePe status check error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Failed to check status' });
  }
};

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
exports.refundPayment = async (req, res) => {
  try {
    const { merchantRefundId, originalMerchantOrderId, amount } = req.body || {};

    if (!merchantRefundId || !originalMerchantOrderId || !amount) {
      return res.status(400).json({ success: false, message: 'Refund details are required' });
    }

    const response = await callPhonePe({
      method: 'post',
      url: `${pgBase()}/payments/v2/refund`,
      data: {
        merchantRefundId,
        originalMerchantOrderId,
        amount: Math.round(Number(amount) * 100), // paise
      },
    });

    if (response.data && response.data.success) {
      return res.json({ success: true, data: response.data.data });
    }
    return res.status(400).json({
      success: false,
      message: response.data?.message || 'Failed to process refund',
    });
  } catch (error) {
    console.error('PhonePe refund error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Failed to process refund' });
  }
};

exports.getRefundStatus = async (req, res) => {
  try {
    const { merchantRefundId } = req.params;

    if (!merchantRefundId) {
      return res.status(400).json({ success: false, message: 'Refund ID is required' });
    }

    const response = await callPhonePe({
      method: 'get',
      url: `${pgBase()}/payments/v2/refund/${encodeURIComponent(merchantRefundId)}/status`,
    });

    if (response.data && response.data.success) {
      return res.json({ success: true, data: response.data.data });
    }
    return res.status(400).json({
      success: false,
      message: response.data?.message || 'Failed to get refund status',
    });
  } catch (error) {
    console.error('PhonePe refund status error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Failed to check refund status' });
  }
};