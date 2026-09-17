const Order = require('../models/Order');
const Counter = require('../models/Counter');
const Seller = require('../models/Seller');
const fs = require('fs').promises;
const path = require('path');
const ordersJsonPath = path.join(__dirname, '../data/orders.json');
const Product = require('../models/Product');
const commissionController = require('./commissionController');
const nodemailer = require('nodemailer');

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
      hour12: true
    }),
    timestamp: deliveryDate.getTime()
  };
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
        orders = orders.filter(o => o._id?.toString() !== id);
        await fs.writeFile(ordersJsonPath, JSON.stringify(orders, null, 2));
      }
    } catch (jsonErr) {
      console.error('Failed to update orders.json after delete:', jsonErr);
    }

    return res.status(200).json({
      success: true,
      message: 'Order deleted successfully.',
      order: deletedOrder
    });
  } catch (error) {
    console.error('Error deleting order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete order.',
      error: error.message
    });
  }
};
// Create a new order
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
      sellerToken,
      transactionId,
      couponCode,
      scheduledDelivery,
      addOns,
    } = req.body;

    // Default paymentStatus if missing from frontend checkout payload
    if (!paymentStatus) {
      paymentStatus = paymentMethod === 'cod' ? 'pending_upfront' : 'pending';
    }

    // Required fields check
    const requiredFields = { customerName, email, phone, address, items, totalAmount, paymentMethod, paymentStatus };
    const missingFields = Object.keys(requiredFields).filter(field => !requiredFields[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // Validate items array
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Items array is required and must not be empty.'
      });
    }

    // Clean & validate item objects
    const cleanedItems = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.name || item.price === undefined || item.quantity === undefined) {
        return res.status(400).json({
          success: false,
          message: `Item ${i + 1} is missing required fields (name, price, or quantity).`
        });
      }

      cleanedItems.push({
        productId: item.productId || null,
        name: String(item.name),
        price: Number(item.price),
        quantity: Number(item.quantity),
        image: item.image || ''
      });
    }

    // Clean addOns array if present
    let cleanedAddOns = [];
    if (Array.isArray(addOns)) {
      cleanedAddOns = addOns.map(addon => ({
        name: String(addon.name),
        price: Number(addon.price || 0),
        quantity: Number(addon.quantity || 1),
        image: addon.image || ''
      }));
    }

    // Process scheduled delivery with IST timezone handling
    let processedScheduledDelivery = null;
    if (scheduledDelivery) {
      const deliveryDate = new Date(scheduledDelivery);
      if (isNaN(deliveryDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid scheduled delivery date format.'
        });
      }

      // Convert times to IST for accurate day and hour checks
      const deliveryDateIST = new Date(deliveryDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const minDeliveryDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      minDeliveryDate.setHours(0, 0, 0, 0);
      minDeliveryDate.setDate(minDeliveryDate.getDate() + 1);

      if (deliveryDateIST < minDeliveryDate) {
        return res.status(400).json({
          success: false,
          message: 'Scheduled delivery must be at least 1 day in the future.'
        });
      }

      const deliveryHourIST = deliveryDateIST.getHours();
      if (deliveryHourIST < 9 || deliveryHourIST > 21) {
        return res.status(400).json({
          success: false,
          message: 'Scheduled delivery time must be between 9:00 AM and 9:00 PM.'
        });
      }

      processedScheduledDelivery = deliveryDate;
    }

    // Generate custom order ID
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
      paymentMethod,
      paymentStatus,
      upfrontAmount: upfrontAmount ? Number(upfrontAmount) : 0,
      remainingAmount: remainingAmount ? Number(remainingAmount) : 0,
      sellerToken: sellerToken || undefined,
      transactionId: transactionId || undefined,
      couponCode: couponCode || undefined,
      scheduledDelivery: processedScheduledDelivery,
    });

    const savedOrder = await newOrder.save();

    // Commission logic
    let commission = 0;
    let seller = null;
    if (sellerToken) {
      seller = await Seller.findOne({ sellerToken });
      if (seller) {
        commission = Number(totalAmount) * 0.30;
        try {
          await commissionController.createCommissionEntry(savedOrder._id, seller._id, Number(totalAmount), 0.30);
          console.log(`Commission entry created for seller ${seller.businessName}: ₹${commission}`);
        } catch (commissionError) {
          console.error('Failed to create commission entry:', commissionError);
        }
      }
    }

    // Update product stock
    for (const item of cleanedItems) {
      if (item.productId) {
        try {
          const product = await Product.findById(item.productId);
          if (product) {
            product.stock = Math.max(0, (product.stock || 0) - (item.quantity || 1));
            if (product.stock === 0) product.inStock = false;
            await product.save();
          }
        } catch (productError) {
          console.error(`Error updating stock for product ${item.productId}:`, productError);
        }
      }
    }

    // JSON backup (non-blocking)
    appendOrderToJson(savedOrder).catch(err => console.error('JSON backup failed:', err));

    // Send confirmation email (non-blocking)
    sendOrderConfirmationEmail(savedOrder).catch(err => console.error('Email notification failed:', err));

    const orderResponse = {
      ...savedOrder.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(savedOrder.scheduledDelivery)
    };

    return res.status(201).json({
      success: true,
      message: 'Order created successfully!',
      order: orderResponse,
      commission: seller ? { amount: commission, sellerName: seller.businessName } : null
    });

  } catch (error) {
    console.error('Error creating order:', error);
    return res.status(error.name === 'ValidationError' ? 400 : 500).json({
      success: false,
      message: error.message || 'Failed to create order.',
      error: error.message
    });
  }
};

// Redesigned order confirmation email
async function sendOrderConfirmationEmail(order) {
  const { email, customerName, items, addOns, totalAmount, address, scheduledDelivery, customOrderId, paymentMethod, paymentStatus, upfrontAmount, remainingAmount, transactionId, phone } = order;
  const subject = '🎉 Congratulations! Your Order is Confirmed - Decoryy';

  const itemsSubtotal = (items || []).reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const addOnsTotal = (addOns && addOns.length > 0) ? addOns.reduce((sum, addOn) => sum + (addOn.price * (addOn.quantity || 1)), 0) : 0;
  const subtotal = itemsSubtotal + addOnsTotal;

  let shipping = 0;
  if (order.shippingCost !== undefined && order.shippingCost !== null) {
    shipping = order.shippingCost;
  } else {
    shipping = Math.max(0, totalAmount - subtotal);
  }

  const itemsHtml = (items || []).map(item => {
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
  }).join('');

  let addOnsHtml = '';
  if (addOns && addOns.length > 0) {
    const addOnRows = addOns.map(addOn => {
      const addOnTotal = addOn.price * (addOn.quantity || 1);
      return `
        <tr>
          <td style="padding: 10px; border: 1px solid #FFECB3;">+ ${addOn.name} ${addOn.quantity > 1 ? `(x${addOn.quantity})` : ''}</td>
          <td style="padding: 10px; border: 1px solid #FFECB3; text-align: center;">${addOn.quantity || 1}</td>
          <td style="padding: 10px; border: 1px solid #FFECB3; text-align: right;">₹${addOn.price.toFixed(2)}</td>
          <td style="padding: 10px; border: 1px solid #FFECB3; text-align: right; font-weight: bold;">₹${addOnTotal.toFixed(2)}</td>
        </tr>
      `;
    }).join('');

    addOnsHtml = `
      <h3 style="color: #444; border-bottom: 2px solid #FFD700; padding-bottom: 5px; margin-top: 25px; margin-bottom: 10px; font-size: 18px;">✨ Add-Ons</h3>
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
  if (address && address.location && Array.isArray(address.location.coordinates) && address.location.coordinates.length === 2) {
    const [lng, lat] = address.location.coordinates;
    mapLink = `<br/><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" style="color: #E65100; font-weight: bold; text-decoration: none;">📍 View on Map</a>`;
  }

  const addressHtml = `
    <p style="margin: 0; line-height: 1.8; font-size: 14px;">
      <strong>${customerName}</strong><br/>
      ${(address && address.street) || ''}<br/>
      ${(address && address.city) ? address.city + ', ' : ''}${(address && address.pincode) || ''}<br/>
      ${(address && address.country) || 'India'}
      ${mapLink}
    </p>
  `;

  let scheduledDeliveryHtml = '';
  if (scheduledDelivery) {
    const deliveryDate = new Date(scheduledDelivery);
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' };
    const formattedDate = deliveryDate.toLocaleString('en-IN', options);
    scheduledDeliveryHtml = `
      <div style="margin-bottom: 20px; padding: 12px; background-color: #FFF9C4; border-left: 4px solid #FBC02D; border-radius: 5px; color: #444;">
        <strong style="font-size: 16px;">📅 Scheduled Delivery:</strong><br/>
        <span style="font-size: 15px;">${formattedDate}</span>
      </div>
    `;
  }

  const paymentMethodText = paymentMethod === 'cod' ? 'Cash on Delivery' : paymentMethod === 'phonepe' || paymentMethod === 'online' ? 'Online Payment (PhonePe)' : paymentMethod || 'N/A';
  const paymentStatusText = paymentStatus === 'completed' ? '✅ Paid' : paymentStatus === 'pending_upfront' ? '⏳ Upfront Pending' : '⏳ Pending';
  const paymentStatusColor = paymentStatus === 'completed' ? '#4CAF50' : '#FF9800';

  let paymentDetailsHtml = `
    <div style="margin-bottom: 20px; padding: 12px; background-color: #F0F4F8; border-left: 4px solid #2196F3; border-radius: 5px;">
      <strong style="font-size: 16px; color: #1976D2;">💳 Payment Method:</strong> ${paymentMethodText}<br/>
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
    timeZone: 'Asia/Kolkata'
  });

  const htmlBody = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background-color: #FFFFFF; border: 3px solid #FFD700; border-radius: 12px; padding: 25px;">
      <div style="text-align: center; background: linear-gradient(135deg, #FFD700 0%, #FFA000 100%); padding: 25px; border-radius: 10px; margin-bottom: 25px;">
        <h1 style="color: #FFFFFF; margin: 0; font-size: 32px;">🎉 Congratulations! 🎉</h1>
        <p style="color: #FFFFFF; margin: 10px 0 0 0; font-size: 18px; font-weight: bold;">Your Order Has Been Confirmed!</p>
      </div>

      <div style="background-color: #FFF9C4; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #FFC107;">
        <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">
          Hello <strong style="color: #E65100;">${customerName}</strong>! 👋 Your celebration preparations are in motion!
        </p>
      </div>

      ${scheduledDeliveryHtml}
      ${paymentDetailsHtml}

      <div style="background-color: #F5F5F5; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="color: #E65100; margin: 0 0 10px 0; font-size: 18px; border-bottom: 2px solid #FFD700; padding-bottom: 5px;">📋 Order Information</h2>
        <p style="margin: 5px 0;"><strong>Order ID:</strong> #${customOrderId}</p>
        <p style="margin: 5px 0;"><strong>Order Date:</strong> ${orderDate}</p>
        ${phone ? `<p style="margin: 5px 0;"><strong>Contact:</strong> ${phone}</p>` : ''}
      </div>

      <div style="background-color: #E3F2FD; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #2196F3;">
        <h3 style="color: #1976D2; margin: 0 0 10px 0; font-size: 18px;">🚚 Delivery Address</h3>
        ${addressHtml}
      </div>

      <div style="background-color: #FFFDE7; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 2px solid #FFD700;">
        <h2 style="color: #E65100; margin: 0 0 15px 0; font-size: 20px; text-align: center;">💰 Bill Summary</h2>
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
    const orders = await Order.find({ email: { $regex: new RegExp(`^${userEmail}$`, 'i') } }).sort({ createdAt: -1 });

    const formattedOrders = orders.map(order => ({
      ...order.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(order.scheduledDelivery)
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
      scheduledDeliveryFormatted: formatScheduledDelivery(order.scheduledDelivery)
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
  const { email, customerName, orderStatus, _id, customOrderId } = order;
  const subject = `🥳 Party Update! Your Order is Now: ${orderStatus.charAt(0).toUpperCase() + orderStatus.slice(1)}`;

  const htmlBody = `
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
  getOrdersByEmail,
  getOrderById,
  deleteOrder,
  sendOrderStatusUpdateEmail,
  formatScheduledDelivery,
};