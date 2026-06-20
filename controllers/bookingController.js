// controllers/bookingController.js (Top half snippet update)
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Seller = require("../models/Seller");
const whatsappClient = require("../config/whatsapp"); // ◄ Handshake your free shared client hook here

// =========================================================================
// PRODUCTION CONFIGURATION CEILINGS
// =========================================================================
const OFFER_TIMEOUT_MS = parseInt(process.env.MATCHMAKING_OFFER_TIMEOUT_MS, 10) || 60000;
const METRO_INNER_RADIUS = parseInt(process.env.METRO_INNER_RADIUS, 10) || 15000;   
const METRO_MAX_CUTOFF = parseInt(process.env.METRO_MAX_CUTOFF, 10) || 40000;       
const ABSOLUTE_MAX_BROADCAST_LIMIT = parseInt(process.env.ABSOLUTE_MAX_BROADCAST_LIMIT, 10) || 8;
const ACTIVE_STATUSES = ["seller_assigned", "cancelled", "completed"];

// =========================================================================
// HELPERS
// =========================================================================
const isValidCoordinate = (lat, lng) =>
  typeof lat === "number" && typeof lng === "number" &&
  !Number.isNaN(lat) && !Number.isNaN(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
const EARTH_RADIUS_METERS = 6371000;
const toRadians = (deg) => (deg * Math.PI) / 180;

const haversineDistanceMeters = (lat1, lng1, lat2, lng2) => {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
};

// =========================================================================
// FREE NOTIFICATION ENGINE (Bypasses Twilio Paid Pipelines via WS Headless Pipe)
// =========================================================================
const sendJobOfferToSeller = async (seller, bookingData) => {
  try {
    if (!seller || !seller.phone) return false;

    // 🛠️ Guard Shield: Fall back to console logs if WhatsApp isn't fully synced yet
    if (!whatsappClient.isReady) {
      console.log(`⚠️ WhatsApp Gateway offline/syncing. Routing fallback console logs for "${seller.businessName}"`);
      return mockConsoleFallback(seller._id, bookingData);
    }

    let formattedPhone = seller.phone.trim().replace(/[\s\-()]/g, "");
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.startsWith('0') ? `91${formattedPhone.slice(1)}` : `91${formattedPhone}`;
    } else {
      formattedPhone = formattedPhone.replace('+', ''); 
    }

    const whatsappTargetId = `${formattedPhone}@c.us`;
    const domain = process.env.PRODUCTION_DOMAIN || "http://localhost:5175";
    const bookingId = bookingData._id;
    const currentSellerName = seller.businessName || "Partner Studio";

    const textBody = `🚨 *NEW BALLOON DECOR JOB BLAST!* 🚨\n\n` +
                     ` Store Partner: *${currentSellerName.toUpperCase()}*\n` +
                     `• Order Type: *${bookingData.serviceDetails.decorType}*\n` +
                     `• Address: ${bookingData.pickupLocation.address}\n\n` +
                     `First vendor to click claims the booking:\n\n` +
                     `👉 ACCEPT: ${domain}/api/bookings/accept/${bookingId}?sellerId=${seller._id}\n\n` +
                     `❌ DECLINE: ${domain}/api/bookings/reject/${bookingId}?sellerId=${seller._id}`;

    await whatsappClient.sendMessage(whatsappTargetId, textBody);
    console.log(`✉️ Free Web Gateway WhatsApp dispatched to ${currentSellerName} (${formattedPhone})`);
    return true; 
  } catch (error) {
    console.error(`❌ Headless browser dispatch exception for seller ${seller._id}:`, error.message);
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
    console.log(`👉 ACCEPT: http://localhost:5175/api/bookings/accept/${bookingData._id}?sellerId=${sellerId}`);
    console.log(`❌ REJECT: http://localhost:5175/api/bookings/reject/${bookingData._id}?sellerId=${sellerId}`);
    console.log(`================================================================\n`);
    return true;
  } catch (err) {
    return false;
  }
};

// =========================================================================
// MATCHMAKING PIPELINE (Simultaneous Broadcast with Unique Sandbox Safeguard)
// =========================================================================
const processMatchmakingPipeline = async (bookingId) => {
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking || ACTIVE_STATUSES.includes(booking.status)) return;

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
      await Booking.findByIdAndUpdate(bookingId, { status: "allocation_failed" });
      console.log("❌ Allocation aborted: All candidate options in local queue opted out or went offline.");
      return;
    }

    const offerExpiresAt = new Date(Date.now() + OFFER_TIMEOUT_MS);
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: { $nin: ACTIVE_STATUSES } },
      { status: "pending_allocation", offerExpiresAt, notifiedSellerId: null },
      { new: true }
    );

    if (!updatedBooking) return;

    // 🛠️ FIX: Filter unique active staging lines to prevent concurrent sandbox message dropping
    const verifiedPhoneTracker = new Set();
    const uniqueDeliveryQueue = [];

    for (const seller of availableSellers) {
      const cleanPhone = seller.phone?.trim();
      if (!cleanPhone) continue;

      if (verifiedPhoneTracker.has(cleanPhone)) {
        console.log(`🚫 De-duplication Shield: Suppressing duplicate concurrent delivery track for "${seller.businessName}" targeting testing number: ${cleanPhone}`);
        continue;
      }
      
      verifiedPhoneTracker.add(cleanPhone);
      uniqueDeliveryQueue.push(seller);
    }

    console.log(`📡 Blasting simultaneous alerts to ${uniqueDeliveryQueue.length} unique verified vendors...`);

    // Fire text requests only to isolated unique channels
    await Promise.all(
      uniqueDeliveryQueue.map((seller) => sendJobOfferToSeller(seller, updatedBooking))
    );

  } catch (error) {
    console.error("Matchmaking Pipeline Error:", error);
  }
};

// =========================================================================
// CREATE INSTANT BOOKING
// =========================================================================
exports.createInstantBooking = async (req, res) => {
  try {
    const { decorType, note, locationAddress, lat, lng, guestCount, eventType } = req.body;
    const userId = req.user.id;
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!decorType || !locationAddress) {
      return res.status(400).json({ success: false, message: "decorType and locationAddress are required." });
    }

    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({ success: false, message: "A valid GPS location configuration is required." });
    }

    console.log(`🔍 Ring 1 Search: Scanning within ${METRO_INNER_RADIUS / 1000}km local radius threshold...`);
    let nearbySellers = await Seller.find({
      approved: true, blocked: false, isOnline: true, isAllocated: false,
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [longitude, latitude] },
          $maxDistance: METRO_INNER_RADIUS,
        },
      },
    }).limit(ABSOLUTE_MAX_BROADCAST_LIMIT);

    if (!nearbySellers || nearbySellers.length === 0) {
      console.log(`⚠️ Ring 1 Empty. Expanding search to Ring 2: City Limits (${METRO_MAX_CUTOFF / 1000}km)...`);
      nearbySellers = await Seller.find({
        approved: true, blocked: false, isOnline: true, isAllocated: false,
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [longitude, latitude] },
            $maxDistance: METRO_MAX_CUTOFF,
          },
        },
      }).limit(ABSOLUTE_MAX_BROADCAST_LIMIT);
    }

    if (!nearbySellers || nearbySellers.length === 0) {
      console.log("❌ Production Hard Cutoff Hit: No available vendors matching this city's area boundary parameters.");
      return res.status(404).json({
        success: false,
        code: "NO_LOCAL_VENDORS",
        message: "We're sorry! No active professional decorators are available within your city limits right now."
      });
    }

    const rankedSellers = nearbySellers
      .map((seller) => {
        const [sellerLng, sellerLat] = seller.location.coordinates;
        const distanceMeters = haversineDistanceMeters(sellerLat, sellerLng, latitude, longitude);
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
      pickupLocation: { address: locationAddress, coordinates: [longitude, latitude] },
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
      message: "Instant booking created successfully. Search pipeline initialized.",
    });

  } catch (error) {
    console.error("Production Error creating instant booking:", error);
    return res.status(500).json({ success: false, message: "Internal application engine booking allocation failure." });
  }
};
// =========================================================================
// GET USER BOOKINGS HISTORY
// =========================================================================
exports.getUserBookings = async (req, res) => {
  try {
    const userId = req.user.id; // Pulled from your userAuth middleware

    const bookings = await Booking.find({ userId })
      .populate("sellerId", "businessName phone rating profileImage")
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      bookings
    });
  } catch (error) {
    console.error("Fetch user bookings error:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to retrieve booking history records." 
    });
  }
};
// =========================================================================
// CREATE SCHEDULED BOOKING
// =========================================================================
exports.createScheduledBooking = async (req, res) => {
  try {
    const { decorType, eventDate, timeSlot, locationAddress, lat, lng, guestCount, eventType } = req.body;
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
 console.log("reached");
    if (!decorType || !locationAddress || !eventDate || !timeSlot) {
      return res.status(400).json({ success: false, message: "Required parameter keys are missing." });
    }

    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({ success: false, message: "A valid GPS geolocation is required." });
    }

    const booking = await Booking.create({
      userId: req.user.id,
      bookingType: "scheduled",
      scheduledTime: new Date(`${eventDate} ${timeSlot}`),
      serviceDetails: { decorType, guestCount, eventType },
      pickupLocation: { address: locationAddress, coordinates: [longitude, latitude] },
    });

    return res.status(201).json({ success: true, booking });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Scheduled booking entry generation failed." });
  }
};

// =========================================================================
// GET BOOKING STATUS
// =========================================================================
exports.getBookingStatus = async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid parameter object payload structure id." });
    }

    const booking = await Booking.findById(bookingId)
      .populate("sellerId", "businessName rating completedBookings profileImage")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking profile records entry not found." });
    }

    if (String(booking.userId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Authorization header context token signature mismatch." });
    }

    return res.json({ success: true, booking });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch booking status parameters." });
  }
};

// =========================================================================
// SELLER ACCEPT BOOKING (Transactional Race Condition Safe)
// =========================================================================
exports.acceptBooking = async (req, res) => {
  const session = await mongoose.startSession();
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
            <p class="text-gray-400 text-sm">Vendor profile signature matching context token properties are invalid.</p>
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
    const errorMsg = error.code ? error.message : "Booking acceptance transaction initialization execution failed.";

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

// =========================================================================
// SELLER REJECT BOOKING (Queue Isolation Management View)
// =========================================================================
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
            <p class="text-gray-400 text-sm">Valid vendor matching parameters were missing from query strings headers.</p>
          </div>
        </body></html>
      `);
    }

    const booking = await Booking.findById(bookingId);
    if (booking && booking.status === "pending_allocation") {
      
      await Booking.findByIdAndUpdate(
        bookingId,
        { $pull: { routingQueue: sellerId } },
        { new: true }
      );

      console.log(`↩️ Vendor ${sellerId} passed on offer option block loop layout profile context map.`);
      
      processMatchmakingPipeline(bookingId).catch((err) =>
        console.error("Pipeline validation loop crash:", err)
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
            <p class="text-gray-400 text-sm">You turned down this booking alert. The pipeline engine is looking for other candidate choices.</p>
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

// =========================================================================
// COMPLETE & CANCEL OPERATIONS
// =========================================================================
exports.completeBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid parameter id value." });
    }

    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: "seller_assigned" },
      { status: "completed", completedAt: new Date() },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking profile not found or not in completable configuration state." });
    }

    await Seller.findByIdAndUpdate(booking.sellerId, {
      isAllocated: false,
      $inc: { completedBookings: 1 },
    });

    return res.json({ success: true, booking });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Completion execution thread faulted." });
  }
};
// =========================================================================
// SELLER PARTNER INTERACTIVE BOOKING ABANDONMENT/CANCELLATION
// =========================================================================
exports.sellerCancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { cancellationReason } = req.body;
    
    // req.seller.id is cleanly decrypted and passed by sellerAuth middleware
    const sellerId = req.seller.id; 

    // 1. Locate the booking assigned to this seller
    const booking = await Booking.findOne({ _id: bookingId, sellerId });
    if (!booking) {
      return res.status(404).json({ 
        success: false, 
        message: "Booking assignment record not found for this partner profile." 
      });
    }

    // 2. Fallback check to ensure the job isn't already completed
    if (booking.status === 'completed') {
      return res.status(400).json({ 
        success: false, 
        message: "Completed workflows cannot be canceled retrospectively." 
      });
    }

    // 3. Update booking parameters
    booking.status = 'cancelled';
    booking.cancellationDetails = {
      cancelledBy: 'seller',
      reason: cancellationReason || 'Declined/Dropped by store partner.',
      timestamp: new Date()
    };
    await booking.save();

    // 4. Free up the seller's active queue status so they can take new incoming instant alerts
    await Seller.findByIdAndUpdate(sellerId, { isAllocated: false });

    return res.status(200).json({ 
      success: true, 
      message: "Order dropped and reservation timeline canceled successfully." 
    });
  } catch (error) {
    console.error("Seller cancel checkout pipeline fault:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Server encountered a drop cancellation timeout thread exception." 
    });
  }
};
exports.cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { cancellationReason } = req.body;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid id structure pattern value." });
    }

    const booking = await Booking.findOne({ _id: bookingId });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking template entry profile missing." });
    }

    if (["completed", "cancelled"].includes(booking.status)) {
      return res.status(409).json({ success: false, message: `Booking context state layout properties already marked as ${booking.status}.` });
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
    return res.status(500).json({ success: false, message: "Cancellation transaction frame failure exception." });
  }
};

exports.processMatchmakingPipeline = processMatchmakingPipeline;