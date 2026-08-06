const mongoose = require('mongoose');

// Schema for individual items within an order
const orderItemSchema = new mongoose.Schema({
  productId: { type: String, required: false },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  image: { type: String, required: false }, // Store primary image for reference
}, { _id: false });

// Schema for optional add-ons
const addOnSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, default: 1 },
  image: { type: String, default: '' } 
}, { _id: false });


// Main schema for an order
const orderSchema = new mongoose.Schema({
  customOrderId: { type: String, unique: true, index: true }, // Custom order ID like decorationcelebration1
  customerName: { type: String, required: true },
  email: { type: String, required: true, index: true }, // Index for fast lookups
  phone: { type: String, required: true },
  address: {
    street: { type: String, required: true },
    pincode: { type: String, required: true },
    country: { type: String, required: true },
    // NEW: For storing Google Maps location coordinates
    location: {
      type: {
        type: String,
        enum: ['Point'], // 'location.type' must be 'Point'
        required: false
      },
      coordinates: {
        type: [Number], // Array of numbers for [longitude, latitude]
        required: false
      }
    }
  },

  // NEW: For scheduling a specific delivery date and time
  scheduledDelivery: { type: Date, required: false },

  items: [orderItemSchema], // Use the correct schema for items

  // NEW: Optional array for add-ons like gift wrap, etc.
  addOns: [addOnSchema],

  totalAmount: { type: Number, required: true },
  paymentMethod: { type: String, required: true },
  orderStatus: {
    type: String,
    default: 'processing',
    enum: ['processing', 'confirmed', 'manufacturing', 'shipped', 'delivered']
  },
  paymentStatus: {
    type: String,
    required: true,
    enum: ['pending', 'completed', 'failed', 'pending_upfront']
  },
  upfrontAmount: { type: Number, default: 0 }, // Upfront payment amount for COD orders
  remainingAmount: { type: Number, default: 0 }, // Remaining amount to be paid on delivery
  sellerToken: { type: String, required: false }, // Track which seller referred this order
  commission: { type: Number, default: 0 }, // Commission amount for this order
  transactionId: { type: String, required: false }, // PhonePe transaction ID
  phonepeMerchantOrderId: { type: String, required: false, index: true }, // For matching PhonePe webhook callbacks
  couponCode: { type: String, required: false }, // Coupon code if applied
}, { timestamps: true });

// NEW: Add a 2dsphere index for efficient location-based queries
orderSchema.index({ 'address.location': '2dsphere' });

module.exports = mongoose.model('Order', orderSchema);