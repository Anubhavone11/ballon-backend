const { getIO } = require("../socket");

// Pushes a live job offer to a specific seller's app — free, self-hosted,
// no per-message or per-connection cost (unlike Pusher's paid tiers).
const sendJobOfferToVendor = async (sellerId, bookingData) => {
  try {
    const io = getIO();
    io.to(`seller_${sellerId}`).emit("job_offer", bookingData);
    return true;
  } catch (error) {
    console.error("sendJobOfferToVendor error:", error);
    return false;
  }
};

module.exports = { sendJobOfferToVendor };
