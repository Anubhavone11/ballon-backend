// backend/models/Notification.js
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    // Who it belongs to: a customer (User) or a partner (Seller/Vendor)
    ownerType: { type: String, enum: ['customer', 'seller'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    route: { type: String, default: '/account' }, // screen to open when tapped
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ ownerId: 1, createdAt: -1 });
// Auto-delete after 60 days so the collection never grows forever
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);