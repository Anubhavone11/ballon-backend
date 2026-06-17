const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Seller = require("../models/Seller");
const twilio = require('twilio');

// =============================
// CONFIG (env-driven so prod values don't require a code change)
// =============================

const OFFER_TIMEOUT_MS =
  parseInt(process.env.MATCHMAKING_OFFER_TIMEOUT_MS, 10) || 60000; // Increased to 60s for easier testing
const SEARCH_RADIUS_METERS =
  parseInt(process.env.SELLER_SEARCH_RADIUS_METERS, 10) || 500000; // 500km fallback for local testing
const MAX_CANDIDATE_SELLERS =
  parseInt(process.env.MAX_CANDIDATE_SELLERS, 10) || 10;

const ACTIVE_STATUSES = ["seller_assigned", "cancelled", "completed"];

// =============================
// HELPERS
// =============================

const isValidCoordinate = (lat, lng) =>
  typeof lat === "number" &&
  typeof lng === "number" &&
  !Number.isNaN(lat) &&
  !Number.isNaN(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180;

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const EARTH_RADIUS_METERS = 6371000;
const toRadians = (deg) => (deg * Math.PI) / 180;

const haversineDistanceMeters = (lat1, lng1, lat2, lng2) => {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
};

// =============================
// REAL NOTIFICATION SYSTEM (Twilio Outbound WhatsApp Engine)
// =============================

const sendJobOfferToSeller = async (sellerId, bookingData) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !twilioNumber) {
      return mockConsoleFallback(sellerId, bookingData);
    }

    const seller = await Seller.findById(sellerId);
    if (!seller || !seller.phone) return false;

    let formattedPhone = seller.phone.trim();
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.startsWith('0') ? `+91${formattedPhone.slice(1)}` : `+91${formattedPhone}`;
    }

    const bookingId = bookingData._id;
    const currentSellerName = seller.businessName || "Unknown Partner Team";

    // 🛠️ FIX: Appending unique sellerId instead of phone number to prevent account collision bugs
    const textBody = `🚨 *NEW BALLOON DECOR JOB BLAST!* 🚨\n\n` +
                     `🏪 *TARGETED SELLER:* ${currentSellerName.toUpperCase()}\n` +
                     `• Order Type: *${bookingData.serviceDetails.decorType}*\n` +
                     `• Address: ${bookingData.pickupLocation.address}\n\n` +
                     `First vendor to click claims the booking:\n\n` +
                     `👉 ACCEPT: http://localhost:5175/api/bookings/accept/${bookingId}?sellerId=${seller._id}\n\n` +
                     `❌ DECLINE: http://localhost:5175/api/bookings/reject/${bookingId}?sellerId=${seller._id}`;

    const client = twilio(accountSid, authToken);
    const message = await client.messages.create({
      body: textBody,
      from: `whatsapp:${twilioNumber}`, 
      to: `whatsapp:${formattedPhone}`   
    });

    console.log(`✉️ WhatsApp blast dispatched to ${currentSellerName} (${formattedPhone}) | SID: ${message.sid}`);
    return true; 
  } catch (error) {
    console.error("Twilio system gateway operation exception:", error.message);
    return false; 
  }
};

const mockConsoleFallback = async (sellerId, bookingData) => {
  try {
    const seller = await Seller.findById(sellerId);
    const sellerPhone = seller ? seller.phone : "0000000000";
    const venueName = seller ? seller.businessName : "Unknown Partner";
    
    console.log(`\n================================================================`);
    console.log(`📱 [MOCK WHATSAPP TRANSMISSION ROUTED TO: ${venueName}]`);
    console.log(`   📞 Targeted Destination: ${sellerPhone}`);
    console.log(`----------------------------------------------------------------`);
    console.log(`👉 COPIED DEEP LINK ACCEPT:`);
    console.log(`   http://localhost:5175/api/bookings/accept/${bookingData._id}?sellerId=${sellerId}`);
    console.log(`\n❌ COPIED DEEP LINK REJECT:`);
    console.log(`   http://localhost:5175/api/bookings/reject/${bookingData._id}?sellerId=${sellerId}`);
    console.log(`================================================================\n`);
    return true;
  } catch (err) {
    return false;
  }
};

// =============================
// MATCHMAKING PIPELINE (Simultaneous Broadcast)
// =============================

const processMatchmakingPipeline = async (bookingId) => {
  try {
    const booking = await Booking.findById(bookingId);

    if (!booking || ACTIVE_STATUSES.includes(booking.status)) {
      return;
    }

    const sellerQueue = booking.routingQueue || [];
    if (sellerQueue.length === 0) return;

    const availableSellers = await Seller.find({
      _id: { $in: sellerQueue },
      isOnline: true,
      isAllocated: false,
      blocked: false,
      approved: true,
    });

    if (availableSellers.length === 0) {
      await Booking.findOneAndUpdate(
        { _id: bookingId, status: { $nin: ACTIVE_STATUSES } },
        { status: "allocation_failed" }
      );
      console.log("❌ No sellers available to receive the broadcast alert.");
      return;
    }

    const offerExpiresAt = new Date(Date.now() + OFFER_TIMEOUT_MS);

    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: { $nin: ACTIVE_STATUSES } },
      {
        status: "pending_allocation",
        offerExpiresAt,
        notifiedSellerId: null, 
      },
      { new: true }
    );

    if (!updatedBooking) return;

    console.log(`📡 Blasting simultaneous alerts to ${availableSellers.length} vendors...`);

    await Promise.all(
      availableSellers.map((seller) => 
        sendJobOfferToSeller(seller._id, updatedBooking)
      )
    );

  } catch (error) {
    console.error("Matchmaking Pipeline Error:", error);
  }
};

// =============================
// CREATE INSTANT BOOKING
// =============================

exports.createInstantBooking = async (req, res) => {
  try {
    const {
      decorType,
      note,
      locationAddress,
      lat,
      lng,
      guestCount,
      eventType,
    } = req.body;
    
    const userId = req.user.id;
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!decorType || !locationAddress) {
      return res.status(400).json({
        success: false,
        message: "decorType and locationAddress are required.",
      });
    }

    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({
        success: false,
        message: "A valid GPS location (lat/lng) is required. Please enable location access.",
      });
    }

    const nearbySellers = await Seller.find({
      approved: true,
      blocked: false,
      isOnline: true,
      isAllocated: false,
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [longitude, latitude] },
          $maxDistance: SEARCH_RADIUS_METERS,
        },
      },
    }).limit(MAX_CANDIDATE_SELLERS);
  console.log(nearbySellers);
    if (!nearbySellers || nearbySellers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No nearby sellers available.",
      });
    }

    const rankedSellers = nearbySellers
      .map((seller) => {
        const [sellerLng, sellerLat] = seller.location.coordinates;
        const distanceMeters = haversineDistanceMeters(
          sellerLat,
          sellerLng,
          latitude,
          longitude
        );

        return {
          id: seller._id,
          score: distanceMeters / (seller.rating || 1),
        };
      })
      .sort((a, b) => a.score - b.score);

    const routingQueue = rankedSellers.map((item) => item.id);

    const booking = await Booking.create({
      userId,
      bookingType: "instant",
      serviceDetails: { decorType, note, guestCount, eventType },
      pickupLocation: {
        address: locationAddress,
        coordinates: [longitude, latitude],
      },
      routingQueue,
      currentRoutingIndex: 0,
    });

    processMatchmakingPipeline(booking._id).catch((err) =>
      console.error("Pipeline kickoff error:", err)
    );

    return res.status(201).json({
      success: true,
      bookingId: booking._id,
      booking,
      message: "Instant booking created.",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Failed to create booking.",
    });
  }
};

// =============================
// CREATE SCHEDULED BOOKING
// =============================

exports.createScheduledBooking = async (req, res) => {
  try {
    const {
      decorType,
      eventDate,
      timeSlot,
      locationAddress,
      lat,
      lng,
      guestCount,
      eventType,
    } = req.body;
    
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!decorType || !locationAddress || !eventDate || !timeSlot) {
      return res.status(400).json({
        success: false,
        message: "decorType, locationAddress, eventDate and timeSlot are required.",
      });
    }

    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({
        success: false,
        message: "A valid GPS location (lat/lng) is required.",
      });
    }

    const booking = await Booking.create({
      userId: req.user.id,
      bookingType: "scheduled",
      scheduledTime: new Date(`${eventDate} ${timeSlot}`),
      serviceDetails: { decorType, guestCount, eventType },
      pickupLocation: {
        address: locationAddress,
        coordinates: [longitude, latitude],
      },
    });

    return res.status(201).json({
      success: true,
      booking,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Scheduled booking failed.",
    });
  }
};

// =============================
// GET BOOKING STATUS
// =============================

exports.getBookingStatus = async (req, res) => {
  try {
    const { bookingId } = req.params;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id." });
    }

    const booking = await Booking.findById(bookingId)
      .populate("sellerId", "businessName rating completedBookings profileImage")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    if (String(booking.userId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    return res.json({ success: true, booking });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch booking status." });
  }
};

// =============================
// SELLER ACCEPT BOOKING (Premium HTML UI & Race Condition Safe)
// =============================

exports.acceptBooking = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { bookingId } = req.params;
    const querySellerId = req.query.sellerId;
    let sellerId;

    // 🛠️ FIX: Direct match against sellerId parameter layout instead of filtering colliding phones
    if (querySellerId && isValidObjectId(querySellerId)) {
      sellerId = querySellerId;
    } else if (req.seller) {
      sellerId = req.seller.id;
    }

    if (!sellerId || !isValidObjectId(bookingId)) {
      return res.status(401).send(`
        <html lang="en"><head><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#121214] text-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
          <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-red-500/20 shadow-2xl text-center space-y-4">
            <div class="text-3xl text-red-400">❌</div>
            <h1 class="text-xl font-bold text-red-400">Authentication Failed</h1>
            <p class="text-gray-400 text-sm">Vendor identity matching parameters are incorrect or missing.</p>
          </div>
        </body></html>
      `);
    }

    let resultBooking = null;

    await session.withTransaction(async () => {
      const booking = await Booking.findOne({
        _id: bookingId,
        status: "pending_allocation",
        offerExpiresAt: { $gt: new Date() },
      }).session(session);

      if (!booking) {
        const err = new Error("This offer has expired, timed out, or was already claimed by another faster vendor.");
        err.code = "OFFER_UNAVAILABLE";
        throw err;
      }

      const seller = await Seller.findOneAndUpdate(
        { _id: sellerId, isAllocated: false },
        { isAllocated: true },
        { new: true, session }
      );

      if (!seller) {
        const err = new Error("You are currently marked as allocated to another active ongoing job layout.");
        err.code = "SELLER_BUSY";
        throw err;
      }

      booking.sellerId = sellerId;
      booking.status = "seller_assigned";
      booking.acceptedAt = new Date();
      booking.notifiedSellerId = null;
      booking.offerExpiresAt = null;

      await booking.save({ session });
      resultBooking = booking;
    });

    if (req.xhr || req.headers.accept?.includes('application/json') || !req.query.sellerId) {
      return res.json({ success: true, message: "Job allocated successfully.", booking: resultBooking });
    }

    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Job Secured!</title><script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-[#121214] text-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
        <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-emerald-500/20 shadow-2xl text-center space-y-6">
          <div class="w-16 h-16 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mx-auto text-3xl animate-bounce">🎉</div>
          <div class="space-y-2">
            <h1 class="text-2xl font-bold text-emerald-400">Order Successfully Claimed!</h1>
            <p class="text-gray-400 text-sm">This booking has been securely locked to your vendor profile dashboard layout.</p>
          </div>
          <div class="p-4 bg-[#121214] rounded-xl border border-gray-800 text-left space-y-2">
            <p class="text-xs text-gray-500 uppercase font-semibold tracking-wider">Order Reference</p>
            <p class="font-mono text-xs text-gray-300 break-all">${bookingId}</p>
          </div>
          <p class="text-xs text-gray-500">You can safely close this browser window tab now.</p>
          <button onclick="window.close()" class="w-full bg-emerald-500 hover:bg-emerald-600 text-[#121214] font-semibold py-3 px-4 rounded-xl transition text-sm">Done</button>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    const errorMsg = error.code ? error.message : "Booking acceptance transaction failed.";

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(409).json({ success: false, message: errorMsg });
    }

    return res.status(409).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Offer Closed</title><script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-[#121214] text-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
        <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-amber-500/20 shadow-2xl text-center space-y-6">
          <div class="w-16 h-16 bg-amber-500/10 text-amber-400 rounded-full flex items-center justify-center mx-auto text-3xl">⏳</div>
          <div class="space-y-2">
            <h1 class="text-xl font-bold text-amber-400">Action Unavailable</h1>
            <p class="text-gray-400 text-sm">${errorMsg}</p>
          </div>
          <button onclick="window.close()" class="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold py-3 px-4 rounded-xl transition text-sm">Close Window</button>
        </div>
      </body>
      </html>
    `);
  } finally {
    await session.endSession();
  }
};

// =============================
// SELLER REJECT BOOKING (Queue-Aware Version)
// =============================

exports.rejectBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const querySellerId = req.query.sellerId;
    let sellerId;

    if (querySellerId && isValidObjectId(querySellerId)) {
      sellerId = querySellerId;
    } else if (req.seller) {
      sellerId = req.seller.id;
    }

    if (!sellerId || !isValidObjectId(bookingId)) {
      return res.status(401).send(`
        <html lang="en"><head><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-[#121214] text-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
          <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-red-500/20 shadow-2xl text-center space-y-4">
            <div class="text-3xl text-red-400">❌</div>
            <h1 class="text-xl font-bold text-red-400">Authentication Failed</h1>
            <p class="text-gray-400 text-sm">Valid vendor matching parameters were missing.</p>
          </div>
        </body></html>
      `);
    }

    // 🛠️ FIX: Pull the specific declining vendor out of the active queue array map block list
    const booking = await Booking.findById(bookingId);
    if (booking && booking.status === "pending_allocation") {
      
      const updatedQueueBooking = await Booking.findByIdAndUpdate(
        bookingId,
        { $pull: { routingQueue: sellerId } },
        { new: true }
      );

      console.log(`↩️ Vendor ${sellerId} opted out. Re-triggering pipeline for remaining candidates...`);
      
      // Immediately run the pipeline to check if another seller in the queue needs to be brought in
      processMatchmakingPipeline(bookingId).catch((err) =>
        console.error("Pipeline bounce execution error:", err)
      );
    }

    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Offer Passed</title><script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-[#121214] text-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
        <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-gray-700 shadow-2xl text-center space-y-6">
          <div class="w-16 h-16 bg-gray-500/10 text-gray-400 rounded-full flex items-center justify-center mx-auto text-3xl">↩️</div>
          <div class="space-y-2">
            <h1 class="text-xl font-bold text-gray-300">Offer Declined</h1>
            <p class="text-gray-400 text-sm">You turned down this booking alert. The pipeline engine is evaluating remaining options.</p>
          </div>
          <button onclick="window.close()" class="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold py-3 px-4 rounded-xl transition text-sm">Close Window</button>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    return res.status(500).send("<h1>Internal Server Error</h1>");
  }
};

// =============================
// COMPLETE BOOKING & CANCEL BOOKING
// =============================

exports.completeBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id." });
    }

    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: "seller_assigned" },
      { status: "completed", completedAt: new Date() },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found or not completable." });
    }

    await Seller.findByIdAndUpdate(booking.sellerId, {
      isAllocated: false,
      $inc: { completedBookings: 1 },
    });

    return res.json({ success: true, booking });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Completion failed." });
  }
};

exports.cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { cancellationReason } = req.body;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id." });
    }

    const booking = await Booking.findOne({ _id: bookingId });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    if (["completed", "cancelled"].includes(booking.status)) {
      return res.status(409).json({ success: false, message: `Booking already ${booking.status}.` });
    }

    const hadSeller = booking.status === "seller_assigned" && booking.sellerId;

    booking.status = "cancelled";
    booking.cancelledAt = new Date();
    booking.cancellationReason = cancellationReason || "";
    booking.notifiedSellerId = null;
    booking.offerExpiresAt = null;

    await booking.save();

    if (hadSeller) {
      await Seller.findByIdAndUpdate(booking.sellerId, { isAllocated: false });
    }

    return res.json({ success: true, booking });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Cancellation failed." });
  }
};

exports.processMatchmakingPipeline = processMatchmakingPipeline;