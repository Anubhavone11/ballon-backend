// backend/notifications/recipients.js
// Helpers that work out WHO should receive a notification.
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

/**
 * Finds the customer account for an order:
 *   1. Logged-in user on req (if route has auth middleware)
 *   2. Explicit order.userId (if sent on the order)
 *   3. Valid Bearer JWT in Authorization header (even on public checkout routes)
 *   4. Account whose phone matches the order phone (last 10 digits)
 *   5. Account whose email matches the order email
 */
async function customerIdForOrder(order, req) {
  const fromAuth = req?.user?._id || req?.user?.id || req?.userId;
  if (fromAuth) return fromAuth;

  if (order?.userId && mongoose.Types.ObjectId.isValid(order.userId)) {
    return order.userId;
  }

  const authHeader = req?.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && process.env.JWT_SECRET) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const tokenId = decoded?._id || decoded?.id || decoded?.userId;
      if (tokenId && mongoose.Types.ObjectId.isValid(tokenId)) {
        return tokenId;
      }
    } catch {
      // Ignore expired/invalid token and fall back to phone/email lookup
    }
  }

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