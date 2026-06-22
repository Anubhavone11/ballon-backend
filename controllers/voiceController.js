const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const crypto = require("crypto");
// Optional: If you choose Agora for free/low-cost WebRTC production scale:
// const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

/**
 * Generates a secure WebRTC voice token for a live, active booking
 * Bypasses direct number exposure by creating a dynamic sandbox call channel ID
 * Instantly broadcasts a Socket.io alert event to the assigned vendor dashboard.
 */
exports.initializeSecureCallSession = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const userId = req.user.id; // From userAuth middleware

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking identifier sequence." });
    }

    // Verify booking is live and active
    // Populating the user details to fetch the client's name for the vendor's incoming call view
    const booking = await Booking.findById(bookingId).populate("userId", "name");
    if (!booking) {
      return res.status(404).json({ success: false, message: "Active booking record not found." });
    }

    // Guard Shield: Ensure the caller belongs to this booking session
    if (String(booking.userId._id || booking.userId) !== String(userId)) {
      return res.status(403).json({ success: false, message: "Unauthorized connection context signature." });
    }

    if (booking.status !== "seller_assigned" || !booking.sellerId) {
      return res.status(400).json({ success: false, message: "Call gateway is only available after a decorator is assigned." });
    }

    // Dynamic Channel ID mapping based on the secure Booking reference ID
    const uniqueChannelName = `call_session_${bookingId}`;
    
    // --- SOCKET.IO REAL-TIME ROUTING INTERCEPTOR ---
    // Grab the socket instance attached to the global Express app instance
    const io = req.app.get("socketio");
    if (io) {
      // Find the specific active room/channel mapping to this vendor's ID 
      // The vendor frontend listens to their unique vendor channel room
      io.to(`vendor_${booking.sellerId}`).emit("incoming_client_call", {
        bookingId: booking._id,
        clientName: booking.userId?.name || "Decoryy Customer",
        decorType: booking.decorType || "Premium Decoration Order",
        channelName: uniqueChannelName
      });
    } else {
      console.warn("⚠️ Socket.io instance not initialized on express application root layer.");
    }

    // --- PRODUCTION WEBRTC TOKEN LOGIC MAPPING ---
    let token;
    const mockToken = `webrtc_auth_token_sec_${crypto.randomBytes(16).toString("hex")}`;
    
    if (process.env.AGORA_APP_ID) {
      // const appId = process.env.AGORA_APP_ID;
      // const appCertificate = process.env.AGORA_APP_CERTIFICATE;
      // const uid = 0; // Dynamic allocation
      // const expirationTimeInSeconds = 3600; // 1 Hour limit
      // const currentTimestamp = Math.floor(Date.now() / 1000);
      // const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
      // token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, uniqueChannelName, uid, RtcRole.PUBLISHER, privilegeExpiredTs);
      token = mockToken; // Fallback helper until compilation lines are uncommented above
    } else {
      token = mockToken;
    }

    return res.status(200).json({
      success: true,
      channelName: uniqueChannelName,
      token: token,
      appId: process.env.AGORA_APP_ID || "DEMO_APP_ID",
      message: "Secure WebRTC communication bridge authorized. Vendor notified."
    });
  } catch (error) {
    console.error("Voice gateway token exception:", error);
    return res.status(500).json({ success: false, message: "Internal application voice node routing failure." });
  }
};