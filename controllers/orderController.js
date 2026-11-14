const Order = require('../models/Order');
const Counter = require('../models/Counter');
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const commissionController = require('./commissionController');
const { emit } = require('../notifications'); // notification system
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const ordersJsonPath = path.join(__dirname, '../data/orders.json');

// Utility function to format scheduled delivery time
const formatScheduledDelivery = (scheduledDelivery) => {
  if (!scheduledDelivery) return null;

  const deliveryDate = new Date(scheduledDelivery);
  return {
    date: deliveryDate.toISOString().split('T')[0], // YYYY-MM-DD format
    time: deliveryDate.toTimeString().split(' ')[0].substring(0, 5), // HH:MM format
    formatted: deliveryDate.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }),
    timestamp: deliveryDate.getTime(),
  };
};

// Normalize phone to country code + number without '+' or symbols
const normalizePhone = (rawPhone) => {
  const clean = String(rawPhone || '').replace(/\D/g, '');
  return clean.length === 10 ? `91${clean}` : clean;
};

// Setup nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Delete an order
const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedOrder = await Order.findByIdAndDelete(id);

    if (!deletedOrder) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Keep orders.json backup in sync
    try {
      const data = await fs.readFile(ordersJsonPath, 'utf8');
      let orders = JSON.parse(data);
      if (Array.isArray(orders)) {
        orders = orders.filter((o) => o._id?.toString() !== id);
        await fs.writeFile(ordersJsonPath, JSON.stringify(orders, null, 2));
      }
    } catch (jsonErr) {
      console.error('Failed to update orders.json after delete:', jsonErr);
    }

    return res.status(200).json({
      success: true,
      message: 'Order deleted successfully.',
      order: deletedOrder,
    });
  } catch (error) {
    console.error('Error deleting order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete order.',
      error: error.message,
    });
  }
};

// Send Order Confirmation via WhatsApp Cloud API
const sendOrderConfirmationWhatsApp = async (order) => {
  let payload = null;

  try {
    if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
      console.error(
        `[WhatsApp] Skipping order #${order.customOrderId}: ` +
          `WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN is not set in the environment.`
      );
      return false;
    }

    if (!order.phone) {
      console.warn(
        `[WhatsApp] Skipping order #${order.customOrderId}: ` +
          `No phone number on the saved order (order.phone is falsy).`
      );
      return false;
    }

    const recipientPhone = normalizePhone(order.phone);

    console.log(
      `[WhatsApp] Order #${order.customOrderId} — raw phone="${order.phone}" ` +
        `normalized="${recipientPhone}" (length=${recipientPhone.length})`
    );

    if (recipientPhone.length < 11 || recipientPhone.length > 13) {
      console.warn(
        `[WhatsApp] Order #${order.customOrderId}: normalized phone ` +
          `"${recipientPhone}" has an unexpected length — message will likely fail silently on Meta's side.`
      );
    }

    // Delivery text formatting
    let deliveryText = 'Standard Delivery';
    if (order.scheduledDelivery) {
      const d = new Date(order.scheduledDelivery);
      deliveryText = d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }

    // Single-line address formatting (Meta rejects multi-line values in body params)
    const addr = order.address || {};
    const street = addr.street || '';
    const city = addr.city ? `, ${addr.city}` : '';
    const pincode = addr.pincode ? ` - ${addr.pincode}` : '';
    const fullAddress = `${street}${city}${pincode}`.trim() || 'Address on file';

    // Payment label mapping
    const paymentStatusMap = {
      completed: 'Paid',
      pending_upfront: 'Upfront Pending',
      pending: 'Pending',
    };
    const paymentLabel = paymentStatusMap[order.paymentStatus] || order.paymentStatus || 'Pending';

    payload = {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'template',
      template: {
        name: 'decoryy_order_confirmation',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: order.customerName || 'Customer' },          // {{1}}
              { type: 'text', text: String(order.customOrderId) },               // {{2}}
              { type: 'text', text: Number(order.totalAmount || 0).toFixed(2) }, // {{3}}
              { type: 'text', text: paymentLabel },                              // {{4}}
              { type: 'text', text: deliveryText },                              // {{5}}
              { type: 'text', text: fullAddress },                               // {{6}}
            ],
          },
        ],
      },
    };

    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(
      `[WhatsApp] Order confirmation sent for #${order.customOrderId}:`,
      response.data?.messages?.[0]?.id
    );
    return true;
  } catch (err) {
    console.error(
      `[WhatsApp] Failed to send order notification for #${order?.customOrderId}:`,
      JSON.stringify(err.response?.data || { message: err.message }, null, 2)
    );
    if (payload) {
      console.error('[WhatsApp] Payload that failed:', JSON.stringify(payload, null, 2));
    }
    return false;
  }
};

// Send Order Status Update via WhatsApp Cloud API
const sendOrderStatusWhatsApp = async (order) => {
  let payload = null;

  try {
    if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
      console.error(
        `[WhatsApp] Skipping status update for #${order.customOrderId}: ` +
          `WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN is not set in the environment.`
      );
      return false;
    }

    if (!order.phone) {
      console.warn(
        `[WhatsApp] Skipping status update for #${order.customOrderId}: ` +
          `No phone number on the order.`
      );
      return false;
    }

    const recipientPhone = normalizePhone(order.phone);

    if (recipientPhone.length < 11 || recipientPhone.length > 13) {
      console.warn(
        `[WhatsApp] Status update for #${order.customOrderId}: normalized phone ` +
          `"${recipientPhone}" has an unexpected length.`
      );
    }

    // Format status nicely (e.g., "out_for_delivery" -> "Out For Delivery")
    const formattedStatus = String(order.orderStatus || 'updated')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());

    payload = {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'template',
      template: {
        name: 'decoryy_order_status', // Create & approve this template in Meta WhatsApp Manager
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: order.customerName || 'Customer' }, // {{1}}
              { type: 'text', text: String(order.customOrderId) },      // {{2}}
              { type: 'text', text: formattedStatus },                  // {{3}}
            ],
          },
        ],
      },
    };

    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(
      `[WhatsApp] Status update (${formattedStatus}) sent for #${order.customOrderId}:`,
      response.data?.messages?.[0]?.id
    );
    return true;
  } catch (err) {
    console.error(
      `[WhatsApp] Failed to send status update for #${order?.customOrderId}:`,
      JSON.stringify(err.response?.data || { message: err.message }, null, 2)
    );
    if (payload) {
      console.error('[WhatsApp] Status payload that failed:', JSON.stringify(payload, null, 2));
    }
    return false;
  }
};

// ---------- Multi-item helpers ----------
const MAX_LINE_ITEMS = 20;   // different packages in one order
const MAX_QTY_PER_ITEM = 10; // quantity of one package
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

const ENFORCE_DB_PRICES = false;
const MIN_LEAD_MINUTES = 0;

// Validates every line, merges duplicates of the same product, caps sizes.
const sanitizeItems = (rawItems) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: 'Items array is required and must not be empty.' };
  }

  const merged = new Map();
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i] || {};
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const price = Number(item.price);
    const quantity = Number(item.quantity);

    if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(quantity) || quantity < 1) {
      return {
        error: `Item ${i + 1} is invalid (needs a name, a price and a whole-number quantity of at least 1).`,
      };
    }

    const productId = item.productId ? String(item.productId) : null;
    if (productId && !OBJECT_ID_RE.test(productId)) {
      return { error: `Item ${i + 1} has an invalid product id.` };
    }

    const key = productId || `name:${name}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
    } else {
      merged.set(key, { productId, name, price, quantity, image: item.image || '' });
    }
  }

  const list = [...merged.values()];
  if (list.length > MAX_LINE_ITEMS) {
    return { error: `You can book up to ${MAX_LINE_ITEMS} different packages in one order.` };
  }
  if (list.some((i) => i.quantity > MAX_QTY_PER_ITEM)) {
    return { error: `You can book up to ${MAX_QTY_PER_ITEM} of the same package in one order.` };
  }
  return { items: list };
};

// One DB round trip for all products: exists, active, in stock, enough quantity.
const checkAvailability = async (items) => {
  const ids = items.filter((i) => i.productId).map((i) => i.productId);
  if (!ids.length) return { ok: true, products: new Map() };

  const products = await Product.find({ _id: { $in: ids } })
    .select('name price stock inStock isActive')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    if (!item.productId) continue;
    const p = byId.get(item.productId);

    if (!p || p.isActive === false) {
      return {
        ok: false,
        status: 409,
        message: `"${item.name}" is no longer available. Please remove it and try again.`,
      };
    }
    if (p.inStock === false || p.stock === 0) {
      return { ok: false, status: 409, message: `"${item.name}" is fully booked right now.` };
    }
    if (typeof p.stock === 'number' && p.stock < item.quantity) {
      return {
        ok: false,
        status: 409,
        message: `Only ${p.stock} of "${item.name}" ${p.stock === 1 ? 'is' : 'are'} available.`,
      };
    }
    if (Number.isFinite(Number(p.price)) && Math.abs(Number(p.price) - item.price) > 0.5) {
      console.warn(`[Order] Price mismatch for ${item.productId}: client=${item.price} db=${p.price}`);
      if (ENFORCE_DB_PRICES) {
        return {
          ok: false,
          status: 409,
          message: `The price of "${item.name}" has changed. Please refresh and try again.`,
        };
      }
    }
  }
  return { ok: true, products: byId };
};

// Puts reserved stock back (used when a later step fails).
const releaseStock = async (reserved) => {
  await Promise.all(
    reserved.map(({ id, qty }) =>
      Product.updateOne({ _id: id }, { $inc: { stock: qty } }).catch((err) =>
        console.error(`[Order] Failed to release stock for ${id}:`, err.message)
      )
    )
  );
};

// Atomic per-product decrement ("only if stock >= qty")
const reserveStock = async (items, productMap) => {
  const reserved = [];

  for (const item of items) {
    if (!item.productId) continue;
    const p = productMap.get(item.productId);
    if (!p || typeof p.stock !== 'number') continue;

    const r = await Product.updateOne(
      { _id: item.productId, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } }
    );
    const changed = (r.modifiedCount ?? r.nModified ?? 0) === 1;

    if (!changed) {
      await releaseStock(reserved);
      return { ok: false, message: `"${item.name}" was just booked by someone else. Please try again.` };
    }
    reserved.push({ id: item.productId, qty: item.quantity });
  }

  if (reserved.length) {
    await Product.updateMany(
      { _id: { $in: reserved.map((r) => r.id) }, stock: { $lte: 0 } },
      { $set: { inStock: false } }
    );
  }
  return { ok: true, reserved };
};

// ---------- Create a new order (single or multiple items) ----------
const createOrder = async (req, res) => {
  try {
    console.log('=== ORDER CREATION REQUEST ===');
    console.log('Payload:', JSON.stringify(req.body, null, 2));

    let {
      customerName,
      email,
      phone,
      address,
      items,
      totalAmount,
      paymentMethod,
      paymentStatus,
      upfrontAmount,
      remainingAmount,
      shippingCost,
      codExtraCharge,
      finalTotal,
      sellerToken,
      transactionId,
      couponCode,
      scheduledDelivery,
      addOns,
    } = req.body;

    if (!paymentStatus) {
      paymentStatus = paymentMethod === 'cod' ? 'pending_upfront' : 'pending';
    }

    const requiredFields = {
      customerName,
      email,
      phone,
      address,
      items,
      totalAmount,
      paymentMethod,
      paymentStatus,
    };
    const missingFields = Object.keys(requiredFields).filter((field) => !requiredFields[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
      });
    }

    if (!Number.isFinite(Number(totalAmount)) || Number(totalAmount) < 0) {
      return res.status(400).json({ success: false, message: 'Invalid total amount.' });
    }

    // 1) Validate + merge the items
    const sanitized = sanitizeItems(items);
    if (sanitized.error) {
      return res.status(400).json({ success: false, message: sanitized.error });
    }
    const cleanedItems = sanitized.items;

    // 2) Clean add-ons
    let cleanedAddOns = [];
    if (Array.isArray(addOns)) {
      cleanedAddOns = addOns
        .filter((a) => a && a.name)
        .map((addon) => ({
          name: String(addon.name),
          price: Math.max(0, Number(addon.price || 0)),
          quantity: Math.max(1, parseInt(addon.quantity, 10) || 1),
          image: addon.image || '',
        }));
    }

    // 3) Scheduled delivery (IST business hours; same-day allowed)
    let processedScheduledDelivery = null;
    if (scheduledDelivery) {
      const deliveryDate = new Date(scheduledDelivery);
      if (isNaN(deliveryDate.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid scheduled delivery date format.' });
      }

      if (deliveryDate.getTime() < Date.now() + MIN_LEAD_MINUTES * 60 * 1000) {
        return res.status(400).json({
          success: false,
          message: 'That time slot has already passed. Please choose a later slot.',
        });
      }

      const deliveryDateIST = new Date(deliveryDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const deliveryHourIST = deliveryDateIST.getHours();
      if (deliveryHourIST < 9 || deliveryHourIST > 21) {
        return res.status(400).json({
          success: false,
          message: 'Scheduled delivery time must be between 9:00 AM and 9:00 PM.',
        });
      }

      processedScheduledDelivery = deliveryDate;
    }

    // 4) Check every package is bookable
    const availability = await checkAvailability(cleanedItems);
    if (!availability.ok) {
      return res.status(availability.status || 409).json({ success: false, message: availability.message });
    }

    // 5) Custom order id
    let customOrderId;
    try {
      const orderNumber = await Counter.getNextSequence('order');
      customOrderId = `decorationcelebration${orderNumber}`;
    } catch (counterErr) {
      console.warn('Counter sequence error, using timestamp fallback:', counterErr.message);
      customOrderId = `decorationcelebration${Date.now()}`;
    }

    const newOrder = new Order({
      customOrderId,
      customerName,
      email,
      phone,
      address,
      items: cleanedItems,
      addOns: cleanedAddOns,
      totalAmount: Number(totalAmount),
      shippingCost: Number(shippingCost) || 0,
      codExtraCharge: Number(codExtraCharge) || 0,
      finalTotal: Number(finalTotal) || Number(totalAmount),
      paymentMethod,
      paymentStatus,
      upfrontAmount: upfrontAmount ? Number(upfrontAmount) : 0,
      remainingAmount: remainingAmount ? Number(remainingAmount) : 0,
      sellerToken: sellerToken || undefined,
      transactionId: transactionId || undefined,
      couponCode: couponCode || undefined,
      scheduledDelivery: processedScheduledDelivery,
    });

    await newOrder.validate();

    // 6) Reserve stock for all packages atomically
    const stock = await reserveStock(cleanedItems, availability.products);
    if (!stock.ok) {
      return res.status(409).json({ success: false, message: stock.message });
    }

    // 7) Save; if saving fails, give the stock back
    let savedOrder;
    try {
      savedOrder = await newOrder.save();
    } catch (saveErr) {
      await releaseStock(stock.reserved);
      throw saveErr;
    }

    console.log(
      `[Order] Saved #${savedOrder.customOrderId} with ${savedOrder.items.length} package(s), ` +
        `phone on saved doc: "${savedOrder.phone}"`
    );

    // 8) Commission logic
    let commission = 0;
    let seller = null;
    if (sellerToken) {
      seller = await Seller.findOne({ sellerToken });
      if (seller) {
        commission = Number(totalAmount) * 0.30;
        try {
          await commissionController.createCommissionEntry(
            savedOrder._id,
            seller._id,
            Number(totalAmount),
            0.30
          );
          console.log(`Commission entry created for seller ${seller.businessName}: ₹${commission}`);
        } catch (commissionError) {
          console.error('Failed to create commission entry:', commissionError);
        }
      }
    }

    // 9) Non-blocking background operations
    appendOrderToJson(savedOrder).catch((err) => console.error('JSON backup failed:', err));
    sendOrderConfirmationEmail(savedOrder).catch((err) => console.error('Email notification failed:', err));
    sendOrderConfirmationWhatsApp(savedOrder).catch((err) => console.error('WhatsApp notification failed:', err));

    emit('order.created', { order: savedOrder, req, seller, commission });

    const orderResponse = {
      ...savedOrder.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(savedOrder.scheduledDelivery),
    };

    return res.status(201).json({
      success: true,
      message: 'Order created successfully!',
      order: orderResponse,
      commission: seller ? { amount: commission, sellerName: seller.businessName } : null,
    });
  } catch (error) {
    console.error('Error creating order:', error);
    return res.status(error.name === 'ValidationError' ? 400 : 500).json({
      success: false,
      message: error.message || 'Failed to create order.',
      error: error.message,
    });
  }
};

// ---------- Update Order Status (Admin / System) ----------
const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { orderStatus, paymentStatus } = req.body;

    if (!OBJECT_ID_RE.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid order id.' });
    }

    if (!orderStatus && !paymentStatus) {
      return res.status(400).json({
        success: false,
        message: 'Provide orderStatus or paymentStatus to update.',
      });
    }

    const existingOrder = await Order.findById(id);
    if (!existingOrder) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const updates = {};
    if (orderStatus) updates.orderStatus = orderStatus;
    if (paymentStatus) updates.paymentStatus = paymentStatus;

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    updateOrderInJson(updatedOrder);

    // Notify customer via Email, Push, and WhatsApp whenever orderStatus actually changes
    if (orderStatus && orderStatus !== existingOrder.orderStatus) {
      sendOrderStatusUpdateEmail(updatedOrder).catch((err) =>
        console.error('Status update notification failed:', err)
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Order status updated successfully.',
      order: {
        ...updatedOrder.toObject(),
        scheduledDeliveryFormatted: formatScheduledDelivery(updatedOrder.scheduledDelivery),
      },
    });
  } catch (error) {
    console.error('Error updating order status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update order status.',
      error: error.message,
    });
  }
};

// ---------- Cancel an order ----------
const ADMIN_CANCELLABLE = ['processing', 'confirmed', 'manufacturing'];
const CUSTOMER_CANCELLABLE = ['processing', 'confirmed'];
const CUSTOMER_CUTOFF_HOURS = 24;

const restoreStock = async (items) => {
  const withIds = (items || []).filter((i) => i.productId);
  await Promise.all(
    withIds.map((i) =>
      Product.updateOne(
        { _id: i.productId, stock: { $type: 'number' } },
        { $inc: { stock: i.quantity } }
      ).catch((err) => console.error(`[Cancel] Stock restore failed for ${i.productId}:`, err.message))
    )
  );
  if (withIds.length) {
    await Product.updateMany(
      { _id: { $in: withIds.map((i) => i.productId) }, stock: { $gt: 0 } },
      { $set: { inStock: true } }
    ).catch((err) => console.error('[Cancel] inStock update failed:', err.message));
  }
};

const updateOrderInJson = async (order) => {
  try {
    const data = await fs.readFile(ordersJsonPath, 'utf8');
    const orders = JSON.parse(data);
    if (!Array.isArray(orders)) return;
    const idx = orders.findIndex((o) => o._id?.toString() === order._id.toString());
    if (idx === -1) return;
    orders[idx] = order.toObject({ virtuals: true });
    await fs.writeFile(ordersJsonPath, JSON.stringify(orders, null, 2));
  } catch (err) {
    console.error('Failed to update orders.json after update:', err);
  }
};

const cancelOrderCore = async (order, { reason, by, allowed }) => {
  const refundNeeded =
    order.paymentStatus === 'completed' ||
    (!!order.transactionId && order.paymentStatus !== 'failed');

  const set = {
    orderStatus: 'cancelled',
    cancelledAt: new Date(),
    cancelReason: String(reason || '').trim().slice(0, 500),
    cancelledBy: by,
  };
  if (refundNeeded) set.paymentStatus = 'refund_pending';

  const cancelled = await Order.findOneAndUpdate(
    { _id: order._id, orderStatus: { $in: allowed } },
    { $set: set },
    { new: true }
  );
  if (!cancelled) return null;

  await restoreStock(cancelled.items);

  if (cancelled.sellerToken && typeof commissionController.cancelCommissionEntry === 'function') {
    try {
      await commissionController.cancelCommissionEntry(cancelled._id);
    } catch (err) {
      console.error('[Cancel] Commission reversal failed:', err);
    }
  }

  updateOrderInJson(cancelled);

  // Sends email, emits push/in-app notification, and sends WhatsApp status update
  sendOrderStatusUpdateEmail(cancelled).catch((err) => console.error('Cancel notification failed:', err));

  return cancelled;
};

const respondCancelled = (res, cancelled) =>
  res.status(200).json({
    success: true,
    message: 'Order cancelled successfully.',
    order: {
      ...cancelled.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(cancelled.scheduledDelivery),
    },
    refundPending: cancelled.paymentStatus === 'refund_pending',
  });

// Admin: PATCH /orders/:id/cancel  { reason }
const adminCancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!OBJECT_ID_RE.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid order id.' });
    }
    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    if (order.orderStatus === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This order is already cancelled.' });
    }
    if (!ADMIN_CANCELLABLE.includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: `An order that is "${order.orderStatus}" can no longer be cancelled.`,
      });
    }

    const cancelled = await cancelOrderCore(order, {
      reason: req.body?.reason,
      by: 'admin',
      allowed: ADMIN_CANCELLABLE,
    });
    if (!cancelled) {
      return res.status(409).json({
        success: false,
        message: 'Order status just changed. Please refresh and try again.',
      });
    }
    return respondCancelled(res, cancelled);
  } catch (error) {
    console.error('Error cancelling order:', error);
    return res.status(500).json({ success: false, message: 'Failed to cancel order.', error: error.message });
  }
};

// Customer: POST /orders/:id/cancel  { email, reason }
const customerCancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!OBJECT_ID_RE.test(id) || !email) {
      return res.status(400).json({ success: false, message: 'Order id and email are required.' });
    }

    const order = await Order.findById(id);
    if (!order || order.email.toLowerCase() !== email) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    if (order.orderStatus === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This order is already cancelled.' });
    }
    if (!CUSTOMER_CANCELLABLE.includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: 'This order is already being prepared. Please contact support to cancel it.',
      });
    }
    if (order.scheduledDelivery) {
      const hoursLeft = (new Date(order.scheduledDelivery).getTime() - Date.now()) / 3600000;
      if (hoursLeft < CUSTOMER_CUTOFF_HOURS) {
        return res.status(400).json({
          success: false,
          message: `Orders can only be cancelled at least ${CUSTOMER_CUTOFF_HOURS} hours before the scheduled time. Please contact support.`,
        });
      }
    }

    const cancelled = await cancelOrderCore(order, {
      reason: req.body?.reason,
      by: 'customer',
      allowed: CUSTOMER_CANCELLABLE,
    });
    if (!cancelled) {
      return res.status(409).json({
        success: false,
        message: 'Order status just changed. Please refresh and try again.',
      });
    }
    return respondCancelled(res, cancelled);
  } catch (error) {
    console.error('Error cancelling order (customer):', error);
    return res.status(500).json({ success: false, message: 'Failed to cancel order.', error: error.message });
  }
};

// Redesigned order confirmation email
async function sendOrderConfirmationEmail(order) {
  const {
    email,
    customerName,
    items,
    addOns,
    totalAmount,
    address,
    scheduledDelivery,
    customOrderId,
    paymentMethod,
    paymentStatus,
    upfrontAmount,
    remainingAmount,
    transactionId,
    phone,
  } = order;
  const subject = 'Your Order is Confirmed - Decoryy';

  const itemsSubtotal = (items || []).reduce((sum, item) => sum + item.price * item.quantity, 0);
  const addOnsTotal =
    addOns && addOns.length > 0
      ? addOns.reduce((sum, addOn) => sum + addOn.price * (addOn.quantity || 1), 0)
      : 0;
  const subtotal = itemsSubtotal + addOnsTotal;

  let shipping = 0;
  if (order.shippingCost !== undefined && order.shippingCost !== null) {
    shipping = order.shippingCost;
  } else {
    shipping = Math.max(0, totalAmount - subtotal);
  }

  const itemsHtml = (items || [])
    .map((item) => {
      const itemTotal = item.price * item.quantity;
      return `
    <tr>
      <td style="padding: 12px; border: 1px solid #FFECB3; vertical-align: top;">
        <strong>${item.name}</strong>
        ${item.image ? `<br/><img src="${item.image}" alt="${item.name}" style="max-width: 80px; max-height: 80px; margin-top: 5px; border-radius: 5px;" />` : ''}
      </td>
      <td style="padding: 12px; border: 1px solid #FFECB3; text-align: center; vertical-align: top;">${item.quantity}</td>
      <td style="padding: 12px; border: 1px solid #FFECB3; text-align: right; vertical-align: top;">₹${item.price.toFixed(2)}</td>
      <td style="padding: 12px; border: 1px solid #FFECB3; text-align: right; vertical-align: top; font-weight: bold;">₹${itemTotal.toFixed(2)}</td>
    </tr>
  `;
    })
    .join('');

  let addOnsHtml = '';
  if (addOns && addOns.length > 0) {
    const addOnRows = addOns
      .map((addOn) => {
        const addOnTotal = addOn.price * (addOn.quantity || 1);
        return `
        <tr>
          <td style="padding: 10px; border: 1px solid #FFECB3;">+ ${addOn.name} ${addOn.quantity > 1 ? `(x${addOn.quantity})` : ''}</td>
          <td style="padding: 10px; border: 1px solid #FFECB3; text-align: center;">${addOn.quantity || 1}</td>
          <td style="padding: 10px; border: 1px solid #FFECB3; text-align: right;">₹${addOn.price.toFixed(2)}</td>
          <td style="padding: 10px; border: 1px solid #FFECB3; text-align: right; font-weight: bold;">₹${addOnTotal.toFixed(2)}</td>
        </tr>
      `;
      })
      .join('');

    addOnsHtml = `
      <h3 style="color: #444; border-bottom: 2px solid #FFD700; padding-bottom: 5px; margin-top: 25px; margin-bottom: 10px; font-size: 18px;">Add-Ons</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr>
            <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: left;">Item</th>
            <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: center;">Qty</th>
            <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: right;">Unit Price</th>
            <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>${addOnRows}</tbody>
      </table>`;
  }

  let mapLink = '';
  if (
    address &&
    address.location &&
    Array.isArray(address.location.coordinates) &&
    address.location.coordinates.length === 2
  ) {
    const [lng, lat] = address.location.coordinates;
    mapLink = `<br/><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" style="color: #E65100; font-weight: bold; text-decoration: none;">View on Map</a>`;
  }

  const addressHtml = `
    <p style="margin: 0; line-height: 1.8; font-size: 14px;">
      <strong>${customerName}</strong><br/>
      ${(address && address.street) || ''}<br/>
      ${address && address.city ? address.city + ', ' : ''}${(address && address.pincode) || ''}<br/>
      ${(address && address.country) || 'India'}
      ${mapLink}
    </p>
  `;

  let scheduledDeliveryHtml = '';
  if (scheduledDelivery) {
    const deliveryDate = new Date(scheduledDelivery);
    const options = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    };
    const formattedDate = deliveryDate.toLocaleString('en-IN', options);
    scheduledDeliveryHtml = `
      <div style="margin-bottom: 20px; padding: 12px; background-color: #FFF9C4; border-left: 4px solid #FBC02D; border-radius: 5px; color: #444;">
        <strong style="font-size: 16px;">Scheduled Delivery:</strong><br/>
        <span style="font-size: 15px;">${formattedDate}</span>
      </div>
    `;
  }

  const paymentMethodText =
    paymentMethod === 'cod'
      ? 'Cash on Delivery'
      : paymentMethod === 'phonepe' || paymentMethod === 'online'
      ? 'Online Payment (PhonePe)'
      : paymentMethod || 'N/A';
  const paymentStatusText =
    paymentStatus === 'completed'
      ? 'Paid'
      : paymentStatus === 'pending_upfront'
      ? 'Upfront Pending'
      : 'Pending';
  const paymentStatusColor = paymentStatus === 'completed' ? '#4CAF50' : '#FF9800';

  let paymentDetailsHtml = `
    <div style="margin-bottom: 20px; padding: 12px; background-color: #F0F4F8; border-left: 4px solid #2196F3; border-radius: 5px;">
      <strong style="font-size: 16px; color: #1976D2;">Payment Method:</strong> ${paymentMethodText}<br/>
      <strong style="font-size: 16px; color: #1976D2;">Status:</strong> <span style="color: ${paymentStatusColor}; font-weight: bold;">${paymentStatusText}</span><br/>
      ${upfrontAmount > 0 ? `<span style="font-size: 14px;">Upfront Amount: ₹${Number(upfrontAmount).toFixed(2)}</span><br/>` : ''}
      ${remainingAmount > 0 ? `<span style="font-size: 14px;">Remaining Due on Delivery: ₹${Number(remainingAmount).toFixed(2)}</span><br/>` : ''}
      ${transactionId ? `<span style="font-size: 14px;">Transaction ID: ${transactionId}</span>` : ''}
    </div>
  `;

  const orderDate = new Date(order.createdAt || new Date()).toLocaleString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

  const htmlBody = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background-color: #FFFFFF; border: 3px solid #FFD700; border-radius: 12px; padding: 25px;">
      <div style="text-align: center; background: linear-gradient(135deg, #FFD700 0%, #FFA000 100%); padding: 25px; border-radius: 10px; margin-bottom: 25px;">
        <h1 style="color: #FFFFFF; margin: 0; font-size: 28px;">Order Confirmed</h1>
        <p style="color: #FFFFFF; margin: 10px 0 0 0; font-size: 16px;">Thank you for your order with Decoryy</p>
      </div>

      <div style="background-color: #FFF9C4; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #FFC107;">
        <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">
          Hello <strong style="color: #E65100;">${customerName}</strong>, your celebration preparations are in motion.
        </p>
      </div>

      ${scheduledDeliveryHtml}
      ${paymentDetailsHtml}

      <div style="background-color: #F5F5F5; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="color: #E65100; margin: 0 0 10px 0; font-size: 18px; border-bottom: 2px solid #FFD700; padding-bottom: 5px;">Order Information</h2>
        <p style="margin: 5px 0;"><strong>Order ID:</strong> #${customOrderId}</p>
        <p style="margin: 5px 0;"><strong>Order Date:</strong> ${orderDate}</p>
        ${phone ? `<p style="margin: 5px 0;"><strong>Contact:</strong> ${phone}</p>` : ''}
      </div>

      <div style="background-color: #E3F2FD; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #2196F3;">
        <h3 style="color: #1976D2; margin: 0 0 10px 0; font-size: 18px;">Delivery Address</h3>
        ${addressHtml}
      </div>

      <div style="background-color: #FFFDE7; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 2px solid #FFD700;">
        <h2 style="color: #E65100; margin: 0 0 15px 0; font-size: 20px; text-align: center;">Bill Summary</h2>
        <table style="width: 100%; border-collapse: collapse; background-color: #FFFFFF;">
          <thead>
            <tr>
              <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: left;">Item</th>
              <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: center;">Qty</th>
              <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: right;">Price</th>
              <th style="padding: 10px; border: 1px solid #FFECB3; background: #FFF176; text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        ${addOnsHtml}
        <div style="background-color: #FFFFFF; padding: 15px; border-radius: 8px; margin-top: 15px;">
          <p style="margin: 5px 0; text-align: right;">Subtotal: <strong>₹${subtotal.toFixed(2)}</strong></p>
          ${shipping > 0 ? `<p style="margin: 5px 0; text-align: right;">Shipping: <strong>₹${shipping.toFixed(2)}</strong></p>` : ''}
          <p style="margin: 8px 0; text-align: right; font-size: 18px; color: #E65100;">Grand Total: <strong>₹${Number(totalAmount).toFixed(2)}</strong></p>
        </div>
      </div>
    </div>
  `;

  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    await transporter.sendMail({
      from: `"Decoryy" <${process.env.EMAIL_USER}>`,
      to: email,
      subject,
      html: htmlBody,
    });
  }
}

const getOrdersByEmail = async (req, res) => {
  try {
    const userEmail = req.query.email;
    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'Email query parameter is required.' });
    }
    const safeEmail = String(userEmail).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orders = await Order.find({ email: { $regex: new RegExp(`^${safeEmail}$`, 'i') } }).sort({
      createdAt: -1,
    });

    const formattedOrders = orders.map((order) => ({
      ...order.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(order.scheduledDelivery),
    }));

    res.status(200).json({ success: true, orders: formattedOrders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch orders.', error: error.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const formattedOrder = {
      ...order.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(order.scheduledDelivery),
    };

    res.status(200).json({ success: true, order: formattedOrder });
  } catch (error) {
    console.error('Error fetching order by ID:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch order.', error: error.message });
  }
};

async function appendOrderToJson(order) {
  try {
    let orders = [];
    try {
      const data = await fs.readFile(ordersJsonPath, 'utf8');
      orders = JSON.parse(data);
      if (!Array.isArray(orders)) orders = [];
    } catch (err) {
      orders = [];
    }
    orders.push(order.toObject ? order.toObject({ virtuals: true }) : order);
    await fs.writeFile(ordersJsonPath, JSON.stringify(orders, null, 2));
  } catch (err) {
    console.error('Failed to append order to orders.json:', err);
  }
}

async function sendOrderStatusUpdateEmail(order) {
  const { email, customerName, orderStatus, customOrderId } = order;
  const isCancelled = orderStatus === 'cancelled';
  const subject = isCancelled
    ? `Order Cancelled: #${customOrderId}`
    : `Order Status Update: #${customOrderId}`;

  // In-app + phone push notification for the status change.
  emit('order.status', { order, status: orderStatus });

  // Send WhatsApp status update (non-blocking)
  sendOrderStatusWhatsApp(order).catch((err) =>
    console.error('Status WhatsApp notification failed:', err)
  );

  const refundNote =
    isCancelled && order.paymentStatus === 'refund_pending'
      ? `<p>Your payment will be refunded to your original payment method. If you don't receive it within 5–7 business days, please contact us.</p>`
      : '';

  const htmlBody = isCancelled
    ? `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 2px solid #E53935; border-radius: 10px;">
      <h2>Hi ${customerName},</h2>
      <p>Your order <strong>#${customOrderId}</strong> has been <strong>cancelled</strong>.</p>
      ${order.cancelReason ? `<p>Reason: ${order.cancelReason}</p>` : ''}
      ${refundNote}
      <p>If you have any questions, just reply to this email.</p>
    </div>
  `
    : `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 2px solid #FFD700; border-radius: 10px;">
      <h2>Hi ${customerName},</h2>
      <p>Your order <strong>#${customOrderId}</strong> has been updated to: <strong>${orderStatus.toUpperCase()}</strong>.</p>
    </div>
  `;

  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    await transporter.sendMail({
      from: `"Decoryy" <${process.env.EMAIL_USER}>`,
      to: email,
      subject,
      html: htmlBody,
    });
  }
}

module.exports = {
  createOrder,
  updateOrderStatus,
  getOrdersByEmail,
  getOrderById,
  deleteOrder,
  sendOrderStatusUpdateEmail,
  sendOrderStatusWhatsApp,
  formatScheduledDelivery,
  adminCancelOrder,
  customerCancelOrder,
};