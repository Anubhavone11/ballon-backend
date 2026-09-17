// File: admin/backend/routes/orders.js
const express = require("express");
const Order = require("../models/Order");
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { createOrder, getOrdersByEmail, getOrderById, sendOrderStatusUpdateEmail, deleteOrder } = require('../controllers/orderController');
const { authenticateToken, isAdmin } = require('../middleware/auth');

const ordersFilePath = path.join(__dirname, '../data/orders.json');

// Helper function to read orders from JSON file
const readOrders = () => {
  try {
    if (fs.existsSync(ordersFilePath)) {
      const data = fs.readFileSync(ordersFilePath, 'utf8');
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    console.error('Error reading orders file:', error);
    return [];
  }
};

// Helper function to write orders to JSON file
const writeOrders = (orders) => {
  try {
    const dirPath = path.dirname(ordersFilePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(ordersFilePath, JSON.stringify(orders, null, 2));
  } catch (error) {
    console.error('Error writing orders file:', error);
    throw new Error('Failed to save order to JSON file');
  }
};
router.delete('/:id', authenticateToken, isAdmin, deleteOrder);
// Admin: Get all orders from MongoDB (not orders.json) - PROTECTED
router.get('/json', authenticateToken, isAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    
    // Import the formatting function from orderController
    const { formatScheduledDelivery } = require('../controllers/orderController');
    
    // Format orders with scheduled delivery information
    const formattedOrders = orders.map(order => ({
      ...order.toObject(),
      scheduledDeliveryFormatted: formatScheduledDelivery(order.scheduledDelivery)
    }));
    
    res.json({ success: true, orders: formattedOrders });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch orders from MongoDB', error: error.message });
  }
});

// Create order
router.post("/", createOrder);

// Update order status - PROTECTED
router.put("/:id/status", authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { orderStatus } = req.body;

    // Validate status
    if (!['processing', 'confirmed', 'manufacturing', 'shipped', 'delivered'].includes(orderStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid order status' });
    }

    // Update in MongoDB
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { orderStatus },
      { new: true, runValidators: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Update in JSON file
    const orders = readOrders();
    const orderIndex = orders.findIndex(order => order._id.toString() === id);
    if (orderIndex !== -1) {
      orders[orderIndex] = updatedOrder.toObject({ virtuals: true });
      writeOrders(orders);
    }

    // Send status update email (non-blocking)
    sendOrderStatusUpdateEmail(updatedOrder).catch(err => console.error('Order status update email error:', err));

    res.json({ success: true, order: updatedOrder });
  } catch (error) {
    console.error('Error updating order status:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid order status',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }
    res.status(500).json({ 
      success: false,
      message: 'Failed to update order status',
      error: error.message 
    });
  }
});

// General order update endpoint - PROTECTED
router.put("/:id", authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Validate orderStatus if provided
    if (updateData.orderStatus && !['processing', 'confirmed', 'manufacturing', 'shipped', 'delivered'].includes(updateData.orderStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid order status' });
    }

    // Validate paymentStatus if provided
    if (updateData.paymentStatus && !['pending', 'completed', 'failed'].includes(updateData.paymentStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid payment status' });
    }

    // Update in MongoDB
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Update in JSON file
    const orders = readOrders();
    const orderIndex = orders.findIndex(order => order._id.toString() === id);
    if (orderIndex !== -1) {
      orders[orderIndex] = updatedOrder.toObject({ virtuals: true });
      writeOrders(orders);
    }

    res.json({ success: true, order: updatedOrder });
  } catch (error) {
    console.error('Error updating order:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid order data',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }
    res.status(500).json({ 
      success: false,
      message: 'Failed to update order',
      error: error.message 
    });
  }
});

// Route to get all orders for a user by email
// GET /api/orders?email=user@example.com
router.get('/', getOrdersByEmail);

// Route to get a single order by its ID
// GET /api/orders/:id
router.get('/:id', getOrderById);

module.exports = router;
