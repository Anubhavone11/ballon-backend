const Booking = require("../models/Booking");

const SWEEP_INTERVAL_MS =
  parseInt(process.env.MATCHMAKING_SWEEP_INTERVAL_MS, 10) || 5000; // 5s

let sweepTimer = null;

const sweepExpiredOffers = async () => {
  try {
    const now = new Date();

    // Find all broadcast bookings that have completely timed out without an allocation match
    const expiredBookings = await Booking.find({
      status: "pending_allocation",
      offerExpiresAt: { $lte: now },
    });

    for (const booking of expiredBookings) {
      // Since it is a simultaneous broadcast, if time expires, the entire window closes.
      // Do NOT increment currentRoutingIndex because everyone got it at the same time.
      await Booking.findByIdAndUpdate(booking._id, {
        status: "allocation_failed",
        notifiedSellerId: null,
        offerExpiresAt: null,
      });
      
      console.log(`⏳ Simultaneous broadcast allocation window expired for booking: ${booking._id}`);
    }
  } catch (error) {
    console.error("Matchmaking Sweep Error:", error);
  }
};

const startMatchmakingSweep = () => {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(sweepExpiredOffers, SWEEP_INTERVAL_MS);
  return sweepTimer;
};

const stopMatchmakingSweep = () => {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
};

module.exports = { startMatchmakingSweep, stopMatchmakingSweep, sweepExpiredOffers };