const Seller = require('../models/Seller');
const Booking = require('../models/Booking');

// Booking statuses that mean "this seller is still on a live job"
const LIVE_STATUSES = ['seller_assigned', 'accepted'];

/**
 * Make a seller available again.
 *
 * Call this AFTER the booking has been saved as completed / cancelled / etc.
 * It only flips the seller to available if they have no other live booking,
 * so it is safe to call from any flow (seller, customer or admin).
 *
 * @param {ObjectId|string} sellerId
 * @param {{ countCompleted?: boolean }} options
 *        countCompleted: also increment the seller's completedBookings counter
 */
const releaseSeller = async (sellerId, { countCompleted = false } = {}) => {
  if (!sellerId) return null;

  const update = {};
  if (countCompleted) update.$inc = { completedBookings: 1 };

  const stillBusy = await Booking.exists({ sellerId, status: { $in: LIVE_STATUSES } });
  if (!stillBusy) update.$set = { isAllocated: false };

  if (!update.$inc && !update.$set) return null;
  return Seller.findByIdAndUpdate(sellerId, update, { new: true });
};

module.exports = { releaseSeller, LIVE_STATUSES };