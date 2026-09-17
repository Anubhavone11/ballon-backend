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

// Create a new order
const createOrder = async (req, res) => {
  try {
    console.log('=== ORDER CREATION REQUEST ===');
    console.log('Request body items:', JSON.stringify(req.body.items, null, 2));
    
    const {
      customerName,
      email,
      phone,
      address, // Expects the full address object, including optional location
      items,
      totalAmount,
      paymentMethod,
      paymentStatus,
      upfrontAmount,
      remainingAmount,
      sellerToken,
      transactionId,
      couponCode,
      scheduledDelivery, // NEW: Get scheduled delivery date/time
      addOns,           // NEW: Get optional add-ons
    } = req.body;

    // Comprehensive validation
    const requiredFields = ['customerName', 'email', 'phone', 'address', 'items', 'totalAmount', 'paymentMethod', 'paymentStatus'];
    const missingFields = requiredFields.filter(field => !req.body[field]);

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

    // Validate each item has required fields and clean the data
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemRequiredFields = ['name', 'price', 'quantity'];
      const missingItemFields = itemRequiredFields.filter(field => !item[field]);
      
      if (missingItemFields.length > 0) {
        return res.status(400).json({ 
          success: false, 
          message: `Item ${i + 1} is missing required fields: ${missingItemFields.join(', ')}` 
        });
      }
      
      // Clean the item data to only include necessary fields
      items[i] = {
        productId: item.productId || null,
        name: item.name,
        price: Number(item.price),
        quantity: Number(item.quantity),
        image: item.image || null
      };
    }
    
    console.log('Cleaned items:', JSON.stringify(items, null, 2));

    // Process scheduled delivery time if provided
    let processedScheduledDelivery = null;
    if (scheduledDelivery) {
      try {
        // Ensure the scheduled delivery is a valid date
        const deliveryDate = new Date(scheduledDelivery);
        if (isNaN(deliveryDate.getTime())) {
          return res.status(400).json({ 
            success: false, 
            message: 'Invalid scheduled delivery date format.' 
          });
        }
        
        // Validate that the delivery date is at least 5 days in the future
      // Validate that the delivery date is at least tomorrow
const minDeliveryDate = new Date();
minDeliveryDate.setHours(0, 0, 0, 0);
minDeliveryDate.setDate(minDeliveryDate.getDate() + 1);

if (deliveryDate < minDeliveryDate) {
  return res.status(400).json({ 
    success: false, 
    message: 'Scheduled delivery must be at least 1 day in the future.' 
  });
}
        
        // Validate that the delivery time is within business hours (9 AM to 9 PM)
        const deliveryTime = deliveryDate.getHours();
        if (deliveryTime < 9 || deliveryTime > 21) {
          return res.status(400).json({ 
            success: false, 
            message: 'Scheduled delivery time must be between 9:00 AM and 9:00 PM.' 
          });
        }
        
        processedScheduledDelivery = deliveryDate;
      } catch (error) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid scheduled delivery date/time format.' 
        });
      }
    }

    // Generate custom order ID
    const orderNumber = await Counter.getNextSequence('order');
    const customOrderId = `decorationcelebration${orderNumber}`;

    const newOrder = new Order({
      customOrderId,
      customerName,
      email,
      phone,
      address, // Use the address object directly
      items,
      totalAmount,
      paymentMethod,
      paymentStatus, // Ensure your schema handles mapping if needed
      upfrontAmount: upfrontAmount || 0,
      remainingAmount: remainingAmount || 0,
      sellerToken,
      transactionId,
      couponCode,
      scheduledDelivery: processedScheduledDelivery, // Processed scheduled delivery
      addOns,           // NEW: Save add-ons
    });

    const savedOrder = await newOrder.save();

    // --- Commission and Stock Logic (unchanged) ---
    let commission = 0;
    let seller = null;
    
    if (sellerToken) {
      seller = await Seller.findOne({ sellerToken });
      if (seller) {
        commission = totalAmount * 0.30;
        try {
          await commissionController.createCommissionEntry(savedOrder._id, seller._id, totalAmount, 0.30);
          console.log(`Commission entry created for seller ${seller.businessName}: ₹${commission}`);
        } catch (commissionError) {
          console.error('Failed to create commission entry:', commissionError);
        }
      }
    }

    for (const item of items) {
      if (item.productId) {
        try {
          const product = await Product.findById(item.productId);
          if (product) {
            product.stock = Math.max(0, (product.stock || 0) - (item.quantity || 1));
            if (product.stock === 0) {
              product.inStock = false;
            }
            await product.save();
          }
        } catch (productError) {
          console.error(`Error updating stock for product ${item.productId}:`, productError);
          // Continue with other products even if one fails
        }
      }
    }
    // --- End of Commission and Stock Logic ---

    await appendOrderToJson(savedOrder);

    // Send the redesigned order confirmation email
    sendOrderConfirmationEmail(savedOrder);
    
    // Format the response with additional scheduled delivery info
    const orderResponse = {
      ...savedOrder.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(savedOrder.scheduledDelivery)
    };

    res.status(201).json({ 
      success: true, 
      message: 'Order created successfully!', 
      order: orderResponse,
      commission: seller ? { amount: commission, sellerName: seller.businessName } : null
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ success: false, message: 'Failed to create order.', error: error.message });
  }
};


// Helper to send the NEW redesigned order confirmation email
async function sendOrderConfirmationEmail(order) {
  const { email, customerName, items, addOns, totalAmount, address, scheduledDelivery, _id, customOrderId, paymentMethod, paymentStatus, upfrontAmount, remainingAmount, transactionId, phone } = order;
  const subject = '🎉 Congratulations! Your Order is Confirmed - Decoryy';

  // Calculate subtotal from items
  const itemsSubtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const addOnsTotal = addOns && addOns.length > 0 ? addOns.reduce((sum, addOn) => sum + (addOn.price * (addOn.quantity || 1)), 0) : 0;
  const subtotal = itemsSubtotal + addOnsTotal;
  // Calculate shipping - try to get from order data or calculate as difference
  let shipping = 0;
  if (order.shippingCost !== undefined && order.shippingCost !== null) {
    shipping = order.shippingCost;
  } else {
    shipping = Math.max(0, totalAmount - subtotal); // Calculate as difference if not provided
  }

  // Build order items table with subtotals
  const itemsHtml = items.map(item => {
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
  
  // Build add-ons table (if they exist)
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
      addOnsHtml = `<h3 style="color: #444; border-bottom: 2px solid #FFD700; padding-bottom: 5px; margin-top: 25px; margin-bottom: 10px; font-size: 18px;">✨ Add-Ons</h3>
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

  // Format Address with Map Link
  let mapLink = '';
  if (address.location && address.location.coordinates && address.location.coordinates.length === 2) {
      const [lng, lat] = address.location.coordinates;
      mapLink = `<br/><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" style="color: #E65100; font-weight: bold; text-decoration: none;">📍 View on Map</a>`;
  }
  const addressHtml = `
    <p style="margin: 0; line-height: 1.8; font-size: 14px;">
      <strong>${customerName}</strong><br/>
      ${address.street || ''}<br/>
      ${address.city ? address.city + ', ' : ''}${address.pincode || ''}<br/>
      ${address.country || 'India'}
      ${mapLink}
    </p>
  `;

  // Format Scheduled Delivery
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

  // Payment information
  const paymentMethodText = paymentMethod === 'cod' ? 'Cash on Delivery' : paymentMethod === 'online' ? 'Online Payment (PhonePe)' : paymentMethod || 'N/A';
  const paymentStatusText = paymentStatus === 'completed' ? '✅ Paid' : paymentStatus === 'pending' ? '⏳ Pending' : paymentStatus || 'N/A';
  const paymentStatusColor = paymentStatus === 'completed' ? '#4CAF50' : paymentStatus === 'pending' ? '#FF9800' : '#757575';
  
  let paymentDetailsHtml = '';
  if (paymentMethod === 'cod') {
    paymentDetailsHtml = `
      <div style="margin-bottom: 20px; padding: 12px; background-color: #E3F2FD; border-left: 4px solid #2196F3; border-radius: 5px;">
        <strong style="font-size: 16px; color: #1976D2;">💳 Payment Method:</strong> ${paymentMethodText}<br/>
        <strong style="font-size: 16px; color: #1976D2;">Status:</strong> <span style="color: ${paymentStatusColor}; font-weight: bold;">${paymentStatusText}</span><br/>
        ${upfrontAmount > 0 ? `<span style="font-size: 14px;">Upfront Paid: ₹${upfrontAmount.toFixed(2)}</span><br/>` : ''}
        ${remainingAmount > 0 ? `<span style="font-size: 14px;">Pay on Delivery: ₹${remainingAmount.toFixed(2)}</span>` : ''}
      </div>
    `;
  } else {
    paymentDetailsHtml = `
      <div style="margin-bottom: 20px; padding: 12px; background-color: #E8F5E9; border-left: 4px solid #4CAF50; border-radius: 5px;">
        <strong style="font-size: 16px; color: #2E7D32;">💳 Payment Method:</strong> ${paymentMethodText}<br/>
        <strong style="font-size: 16px; color: #2E7D32;">Status:</strong> <span style="color: ${paymentStatusColor}; font-weight: bold;">${paymentStatusText}</span><br/>
        ${transactionId ? `<span style="font-size: 14px;">Transaction ID: ${transactionId}</span>` : ''}
      </div>
    `;
  }

  // Order date
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
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background-color: #FFFFFF; border: 3px solid #FFD700; border-radius: 12px; padding: 25px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
      <!-- Header with Congratulations -->
      <div style="text-align: center; background: linear-gradient(135deg, #FFD700 0%, #FFA000 100%); padding: 25px; border-radius: 10px; margin-bottom: 25px;">
        <h1 style="color: #FFFFFF; margin: 0; font-size: 36px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2);">🎉 Congratulations! 🎉</h1>
        <p style="color: #FFFFFF; margin: 10px 0 0 0; font-size: 18px; font-weight: bold;">Your Order Has Been Confirmed!</p>
      </div>

      <div style="padding: 0 10px;">
        <!-- Greeting -->
        <div style="background-color: #FFF9C4; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #FFC107;">
          <p style="color: #333; font-size: 18px; line-height: 1.6; margin: 0;">
            Hello <strong style="color: #E65100;">${customerName}</strong>! 👋
          </p>
          <p style="color: #555; font-size: 16px; line-height: 1.6; margin: 10px 0 0 0;">
            🎊 <strong>Congratulations!</strong> Your order has been successfully placed and confirmed. We're thrilled to be part of your celebration! Your party preparations are now in motion, and we can't wait to help make your event absolutely special and memorable.
          </p>
        </div>

        ${scheduledDeliveryHtml}
        ${paymentDetailsHtml}

        <!-- Order Information Section -->
        <div style="background-color: #F5F5F5; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #E65100; margin: 0 0 15px 0; font-size: 20px; border-bottom: 2px solid #FFD700; padding-bottom: 8px;">📋 Order Information</h2>
          <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 15px;">
            <div style="flex: 1; min-width: 200px;">
              <p style="margin: 5px 0; color: #666; font-size: 13px;">Order ID</p>
              <p style="margin: 0; color: #333; font-size: 16px; font-weight: bold;">#${customOrderId}</p>
            </div>
            <div style="flex: 1; min-width: 200px;">
              <p style="margin: 5px 0; color: #666; font-size: 13px;">Order Date</p>
              <p style="margin: 0; color: #333; font-size: 14px;">${orderDate}</p>
            </div>
            ${phone ? `
            <div style="flex: 1; min-width: 200px;">
              <p style="margin: 5px 0; color: #666; font-size: 13px;">Contact</p>
              <p style="margin: 0; color: #333; font-size: 14px;">${phone}</p>
            </div>
            ` : ''}
          </div>
        </div>

        <!-- Shipping Address -->
        <div style="background-color: #E3F2FD; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #2196F3;">
          <h3 style="color: #1976D2; margin: 0 0 10px 0; font-size: 18px;">🚚 Delivery Address</h3>
          ${addressHtml}
        </div>

        <!-- Bill/Invoice Section -->
        <div style="background-color: #FFFDE7; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 2px solid #FFD700;">
          <h2 style="color: #E65100; margin: 0 0 20px 0; font-size: 22px; text-align: center; border-bottom: 3px solid #FFD700; padding-bottom: 10px;">💰 Order Bill / Invoice</h2>
          
          <h3 style="color: #444; border-bottom: 2px solid #FFD700; padding-bottom: 8px; margin-bottom: 15px; font-size: 18px;">🎈 Order Items</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 14px; background-color: #FFFFFF;">
            <thead>
              <tr>
                <th style="padding: 12px; border: 1px solid #FFECB3; background: #FFF176; text-align: left;">Item</th>
                <th style="padding: 12px; border: 1px solid #FFECB3; background: #FFF176; text-align: center;">Qty</th>
                <th style="padding: 12px; border: 1px solid #FFECB3; background: #FFF176; text-align: right;">Unit Price</th>
                <th style="padding: 12px; border: 1px solid #FFECB3; background: #FFF176; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>

          ${addOnsHtml}

          <!-- Bill Summary -->
          <div style="background-color: #FFFFFF; padding: 15px; border-radius: 8px; margin-top: 20px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px; text-align: right; color: #666; font-size: 14px;">Subtotal:</td>
                <td style="padding: 8px; text-align: right; font-weight: bold; font-size: 14px;">₹${subtotal.toFixed(2)}</td>
              </tr>
              ${shipping > 0 ? `
              <tr>
                <td style="padding: 8px; text-align: right; color: #666; font-size: 14px;">Shipping:</td>
                <td style="padding: 8px; text-align: right; font-weight: bold; font-size: 14px;">₹${shipping.toFixed(2)}</td>
              </tr>
              ` : ''}
              <tr style="border-top: 2px solid #FFD700; border-bottom: 2px solid #FFD700;">
                <td style="padding: 12px; text-align: right; font-size: 18px; font-weight: bold; color: #E65100;">Grand Total:</td>
                <td style="padding: 12px; text-align: right; font-size: 20px; font-weight: bold; color: #E65100;">₹${totalAmount.toFixed(2)}</td>
              </tr>
            </table>
          </div>
        </div>
        
        <!-- Footer -->
        <div style="border-top: 2px dashed #FFC107; padding-top: 20px; margin-top: 25px; text-align: center; background-color: #FFF9C4; padding: 20px; border-radius: 8px;">
          <p style="color: #555; font-size: 15px; margin: 0 0 10px 0; line-height: 1.6;">
            <strong>🎊 Thank you for choosing Decoryy!</strong><br/>
            We're excited to be part of your celebration journey.
          </p>
          <p style="color: #666; font-size: 14px; margin: 15px 0 0 0;">
            If you have any questions or need assistance, just reply to this email. We're here to help make your event perfect! 💝
          </p>
          <p style="color: #E65100; font-size: 16px; margin: 20px 0 0 0; font-weight: bold;">
            Happy Celebrating! 🥳<br/>
            <span style="font-size: 14px; color: #666;">The Decoryy Team</span>
          </p>
        </div>
      </div>
    </div>
  `;

  // Plain text version
  const textBody = `🎉 Congratulations ${customerName}! 🎉

Your order has been successfully confirmed! We're thrilled to be part of your celebration.

ORDER INFORMATION:
==================
Order ID: #${customOrderId}
Order Date: ${orderDate}
${phone ? `Contact: ${phone}\n` : ''}

${scheduledDelivery ? `Scheduled Delivery: ${new Date(scheduledDelivery).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` : ''}

PAYMENT DETAILS:
================
Payment Method: ${paymentMethodText}
Payment Status: ${paymentStatusText}
${transactionId ? `Transaction ID: ${transactionId}\n` : ''}
${paymentMethod === 'cod' && upfrontAmount > 0 ? `Upfront Paid: ₹${upfrontAmount.toFixed(2)}\n` : ''}
${paymentMethod === 'cod' && remainingAmount > 0 ? `Pay on Delivery: ₹${remainingAmount.toFixed(2)}\n` : ''}

DELIVERY ADDRESS:
=================
${customerName}
${address.street || ''}
${address.city ? address.city + ', ' : ''}${address.pincode || ''}
${address.country || 'India'}

ORDER ITEMS:
============
${items.map(item => `- ${item.name} x${item.quantity} = ₹${(item.price * item.quantity).toFixed(2)}`).join('\n')}

${addOns && addOns.length > 0 ? 'ADD-ONS:\n' + addOns.map(a => `- ${a.name} ${a.quantity > 1 ? `(x${a.quantity})` : ''} = ₹${(a.price * (a.quantity || 1)).toFixed(2)}`).join('\n') + '\n' : ''}

BILL SUMMARY:
=============
Subtotal: ₹${subtotal.toFixed(2)}
${shipping > 0 ? `Shipping: ₹${shipping.toFixed(2)}\n` : ''}
Grand Total: ₹${totalAmount.toFixed(2)}

🎊 Thank you for choosing Decoryy! We're excited to help make your event special.

If you have any questions, just reply to this email. We're here to help!

Happy Celebrating! 🥳
The Decoryy Team`;

  try {
    await transporter.sendMail({
      from: `"Decoryy" <${process.env.EMAIL_USER}>`,
      to: email,
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log(`Order confirmation email sent to ${email}`);
  } catch (mailErr) {
    console.error('Error sending order confirmation email:', mailErr);
  }
}


// --- Unchanged Functions (getOrdersByEmail, getOrderById, appendOrderToJson) ---
// These functions do not need to be modified for this request.
// I have included them here for completeness.

const getOrdersByEmail = async (req, res) => {
  try {
    const userEmail = req.query.email;
    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'Email query parameter is required.' });
    }
    const orders = await Order.find({ email: { $regex: new RegExp(`^${userEmail}$`, 'i') } }).sort({ createdAt: -1 });
    
    // Format orders with scheduled delivery information
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
    
    // Format order with scheduled delivery information
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


// BONUS: Updated Order Status Email with new branding
async function sendOrderStatusUpdateEmail(order) {
  const { email, customerName, orderStatus, _id, customOrderId } = order;
  const subject = `🥳 Party Update! Your Order is Now: ${orderStatus.charAt(0).toUpperCase() + orderStatus.slice(1)}`;

  const htmlBody = `
    <div style="font-family: 'Comic Sans MS', 'Chalkboard SE', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #FFFDE7; border: 5px solid #FFD700; border-radius: 15px; padding: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
      <div style="text-align: center; border-bottom: 2px dashed #FFC107; padding-bottom: 15px; margin-bottom: 25px;">
        <h1 style="color: #FF6F00; margin: 0; font-size: 32px;">Decoryy!</h1>
        <p style="color: #666; margin: 5px 0; font-size: 16px;">An Update on Your Celebration!</p>
      </div>
      <div style="padding: 0 10px;">
        <p style="color: #333; font-size: 18px; line-height: 1.6; margin: 0;">
          Hi <strong>${customerName}</strong>,
        </p>
        <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 15px 0;">
          Just a quick note to let you know your order #${customOrderId} has been updated.
        </p>
        <div style="text-align: center; margin: 25px 0; padding: 15px; background-color: #FFF9C4; border-radius: 10px; border: 2px solid #FBC02D;">
          <p style="margin: 0; font-size: 16px; color: #555;">New Status:</p>
          <p style="margin: 5px 0 0 0; font-size: 24px; font-weight: bold; color: #E65100;">${orderStatus.charAt(0).toUpperCase() + orderStatus.slice(1)}</p>
        </div>
        <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 25px 0;">
          We're working hard to get your goodies to you. We'll send another update when it's on its way!
        </p>
        <div style="border-top: 2px dashed #FFC107; padding-top: 20px; margin-top: 20px; text-align: center;">
          <p style="color: #555; font-size: 16px; margin: 15px 0;">
            <strong>Cheers,</strong><br>
            The Decoryy Team 🥳
          </p>
        </div>
      </div>
    </div>
  `;
  
  const textBody = `Hi ${customerName},\n\nAn update on your Decoryy order #${customOrderId}.\nDatabase ID: ${_id}\nNew Status: ${orderStatus.charAt(0).toUpperCase() + orderStatus.slice(1)}\n\nCheers,\nThe Decoryy Team 🥳`;

  try {
    await transporter.sendMail({
      from: `"Decoryy" <${process.env.EMAIL_USER}>`,
      to: email,
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log(`Order status update email sent to ${email}`);
  } catch (mailErr) {
    console.error('Error sending order status update email:', mailErr);
  }
}

module.exports = {
  createOrder,
  getOrdersByEmail,
  getOrderById,
  sendOrderStatusUpdateEmail,
  formatScheduledDelivery,
};