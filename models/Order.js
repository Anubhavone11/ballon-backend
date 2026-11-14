const mongoose = require('mongoose');

// One line in the order. An order can hold many of these (one per package).
const orderItemSchema = new mongoose.Schema({
  productId: { type: String, required: false },
  name: { type: String, required: true },
  price: { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 1 },
  image: { type: String, required: false }, // Store primary image for reference
}, { _id: false });

// Schema for optional add-ons
const addOnSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true, min: 0 },
  quantity: { type: Number, default: 1, min: 1 },
  image: { type: String, default: '' }
}, { _id: false });

// Main schema for an order
const orderSchema = new mongoose.Schema({
  customOrderId: { type: String, unique: true, index: true }, // Custom order ID like decorationcelebration1
  customerName: { type: String, required: true },
  email: { type: String, required: true, index: true },
  phone: { type: String, required: true },
  address: {
    street: { type: String, required: true },
    city: { type: String, required: false, default: '' },
    // The admin Orders page filters on address.state; without this field Mongoose drops it.
    state: { type: String, required: false, default: '' },
    pincode: { type: String, required: true },
    country: { type: String, required: true },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: false
      },
      coordinates: {
        type: [Number],
        required: false
      }
    }
  },

  scheduledDelivery: { type: Date, required: false },

  // Many packages per order are allowed, but never zero.
  items: {
    type: [orderItemSchema],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: 'An order must contain at least one item.'
    }
  },

  addOns: [addOnSchema],

  totalAmount: { type: Number, required: true },

  // Sent by the checkout; stored so the admin and emails can show a full breakdown
  shippingCost: { type: Number, default: 0 },
  codExtraCharge: { type: Number, default: 0 },
  finalTotal: { type: Number, default: 0 },

  paymentMethod: { type: String, required: true },
  orderStatus: {
    type: String,
    default: 'processing',
    enum: ['processing', 'confirmed', 'manufacturing', 'shipped', 'delivered', 'cancelled']
  },
  paymentStatus: {
    type: String,
    required: true,
    enum: ['pending', 'completed', 'failed', 'pending_upfront', 'refund_pending', 'refunded']
  },

  // Cancellation details
  cancelledAt: { type: Date },
  cancelReason: { type: String, default: '' },
  cancelledBy: { type: String, enum: ['admin', 'customer'] },

  upfrontAmount: { type: Number, default: 0 },
  remainingAmount: { type: Number, default: 0 },
  sellerToken: { type: String, required: false },
  commission: { type: Number, default: 0 },
  transactionId: { type: String, required: false },
  phonepeMerchantOrderId: { type: String, required: false, index: true },
  couponCode: { type: String, required: false },
}, { timestamps: true });

// Handy for lists and notifications: total number of packages in the order
orderSchema.virtual('itemCount').get(function () {
  return (this.items || []).reduce((sum, i) => sum + (i.quantity || 0), 0);
});
orderSchema.set('toObject', { virtuals: true });
orderSchema.set('toJSON', { virtuals: true });

// Find orders that contain a given product (admin reports)
orderSchema.index({ 'items.productId': 1 });

orderSchema.index({ 'address.location': '2dsphere' });

module.exports = mongoose.model('Order', orderSchema);