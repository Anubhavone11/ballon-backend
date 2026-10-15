// backend/notifications/recipients.js
// Helpers that work out WHO should receive a notification.
const mongoose = require('mongoose');

/**
 * Orders don't store a userId, so find the customer account for an order:
 *   1. the logged-in user on the request (if the route has login middleware)
 *   2. the account whose phone matches the order phone (last 10 digits)
 *   3. the account whose email matches the order email
 */
async function customerIdForOrder(order, req) {
  const fromAuth = req?.user?._id || req?.userId;
  if (fromAuth) return fromAuth;

  const User = mongoose.models.User;
  if (!User) return null;

  const last10 = String(order.phone || '').replace(/\D/g, '').slice(-10);
  if (last10.length === 10) {
    const byPhone = await User.findOne({ phone: { $regex: `${last10}$` } }).select('_id');
    if (byPhone) return byPhone._id;
  }

  if (order.email) {
    const byEmail = await User.findOne({ email: String(order.email).toLowerCase() }).select('_id');
    if (byEmail) return byEmail._id;
  }

  return null;
}

module.exports = { customerIdForOrder };