const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Seller = require("../models/Seller");
const Product = require("../models/Product");

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ─── WhatsApp client setup ────────────────────────────────────────────────────

const whatsappClient = new Client({
  authStrategy: new LocalAuth({ clientId: "decoryy_production_session" }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

whatsappClient.on('qr', (qr) => {
  console.log('▼ Scan this QR code with WhatsApp to activate the Decoryy Engine ▼');
  qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
  console.log('✅ Decoryy WhatsApp Engine is live and ready.');
});

whatsappClient.on('auth_failure', () => {
  console.error('❌ WhatsApp authentication failed. Delete the session folder and restart.');
});

whatsappClient.initialize();

// ─── Configuration ────────────────────────────────────────────────────────────

const OFFER_TIMEOUT_MS            = parseInt(process.env.MATCHMAKING_OFFER_TIMEOUT_MS, 10) || 60000;
const METRO_INNER_RADIUS          = parseInt(process.env.METRO_INNER_RADIUS, 10)           || 15000;
const METRO_MAX_CUTOFF            = parseInt(process.env.METRO_MAX_CUTOFF, 10)             || 40000;
const ABSOLUTE_MAX_BROADCAST_LIMIT = parseInt(process.env.ABSOLUTE_MAX_BROADCAST_LIMIT, 10) || 12;
const ANTI_BAN_DELAY_MS           = parseInt(process.env.ANTI_BAN_DELAY_MS, 10)           || 40000;

const ACTIVE_STATUSES = ["seller_assigned", "cancelled", "completed"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isValidCoordinate = (lat, lng) =>
  typeof lat === "number" && typeof lng === "number" &&
  !Number.isNaN(lat) && !Number.isNaN(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const toRadians = (deg) => (deg * Math.PI) / 180;

const haversineDistanceMeters = (lat1, lng1, lat2, lng2) => {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Normalise an Indian phone number to WhatsApp ID format (91XXXXXXXXXX@c.us)
const toWhatsAppId = (rawPhone) => {
  const clean = rawPhone.trim().replace(/[\s\-()+]/g, "");
  const withCountryCode = clean.length === 10 ? `91${clean}` : clean;
  return `${withCountryCode}@c.us`;
};

// ─── WhatsApp job offer dispatcher ───────────────────────────────────────────

const sendJobOfferToSeller = async (seller, booking) => {
  try {
    if (!seller?.businessPhone) {
      console.warn(`⚠️ Skipping seller ${seller?._id}: no phone number.`);
      return false;
    }

    const whatsappId = toWhatsAppId(seller.businessPhone);
    const item = booking.selectedProductId; // populated Product document

    const clientName     = booking.serviceDetails?.name     || "Customer";
    const eventTheme     = booking.serviceDetails?.decorType || "Not specified";
    const venueAddress   = booking.pickupLocation?.address  || "See dashboard";
    const bookingId      = booking._id;

    // Build product description line
    const itemName         = item?.name  || "Custom decoration";
    const itemPrice        = item?.price != null ? `₹${item.price}` : "—";
    const deliveryTime     = item?.instantDeliveryTime || null;
    const deliveryTimeLine = deliveryTime ? `⏱️ *Delivery time:* ${deliveryTime}` : "";

    // One-click accept / reject URLs
    const acceptUrl = `${process.env.APP_URL || 'http://localhost:5175'}/api/bookings/accept/${bookingId}?sellerId=${seller._id}`;
    const rejectUrl = `${process.env.APP_URL || 'http://localhost:5175'}/api/bookings/reject/${bookingId}?sellerId=${seller._id}`;

    const message =
      `✨ *NEW JOB OFFER — DECORYY* ✨\n\n` +
      `👤 *Client:* ${clientName}\n` +
      `🎨 *Theme:* ${eventTheme}\n` +
      `📦 *Item:* ${itemName} (${itemPrice})\n` +
      (deliveryTimeLine ? `${deliveryTimeLine}\n` : '') +
      `📍 *Venue:* ${venueAddress}\n\n` +
      `✅ *Accept this job:*\n${acceptUrl}\n\n` +
      `❌ *Reject / pass:*\n${rejectUrl}\n\n` +
      `_You have 60 seconds to respond before this offer moves to the next decorator._`;

    // Prefer sending the product image as the media attachment.
    // Falls back to text-only if no image or if the download fails.
    const productImageUrl = item?.image || item?.images?.[0] || null;

    if (productImageUrl) {
      try {
        const media = await MessageMedia.fromUrl(productImageUrl, { unsafeMime: true });
        await whatsappClient.sendMessage(whatsappId, media, { caption: message });
        console.log(`📸 Product image + offer sent to ${seller.name}`);
        return true;
      } catch (mediaErr) {
        console.warn(`⚠️ Could not attach product image for ${seller.name}: ${mediaErr.message}. Sending text only.`);
      }
    }

    // Text-only fallback
    await whatsappClient.sendMessage(whatsappId, message);
    console.log(`📝 Text offer sent to ${seller.name}`);
    return true;

  } catch (err) {
    console.error(`❌ Failed to send offer to seller ${seller?._id}:`, err.message);
    return false;
  }
};

// ─── Matchmaking pipeline ─────────────────────────────────────────────────────

const processMatchmakingPipeline = async (bookingId) => {
  try {
    const booking = await Booking.findById(bookingId).populate('selectedProductId');
    if (!booking || ACTIVE_STATUSES.includes(booking.status)) return;

    const sellerQueue = booking.routingQueue || [];
    if (sellerQueue.length === 0) {
      await Booking.findByIdAndUpdate(bookingId, { status: "allocation_failed" });
      return;
    }

    const availableSellers = await Seller.find({
      _id: { $in: sellerQueue },
      isOnline: true,
      isAllocated: false,
      blocked: false,
      approved: true,
    });

    if (availableSellers.length === 0) {
      await Booking.findByIdAndUpdate(bookingId, { status: "allocation_failed" });
      console.log(`❌ No available sellers for booking ${bookingId}.`);
      return;
    }

    // Lock the booking into pending_allocation
    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: { $nin: ACTIVE_STATUSES } },
      {
        status: "pending_allocation",
        offerExpiresAt: new Date(Date.now() + OFFER_TIMEOUT_MS),
        notifiedSellerId: null,
      },
      { new: true }
    ).populate('selectedProductId');

    if (!updatedBooking) return;

    // Deduplicate sellers by phone number, preserve priority order
    const orderMap = sellerQueue.map(String);
    const sorted = availableSellers.sort(
      (a, b) => orderMap.indexOf(String(a._id)) - orderMap.indexOf(String(b._id))
    );

    const seenPhones = new Set();
    const dedupedQueue = sorted.filter((s) => {
      const phone = s.businessPhone?.trim();
      if (!phone || seenPhones.has(phone)) return false;
      seenPhones.add(phone);
      return true;
    });

    console.log(`📡 Sending offers to ${dedupedQueue.length} decorator(s) in ${updatedBooking.serviceDetails?.city || 'city'}...`);

    for (const seller of dedupedQueue) {
      // Stop if someone already accepted
      const current = await Booking.findById(bookingId).select("status").lean();
      if (current && ACTIVE_STATUSES.includes(current.status)) {
        console.log(`🛑 Booking ${bookingId} already taken. Stopping queue.`);
        break;
      }

      await sendJobOfferToSeller(seller, updatedBooking);
      console.log(`⏳ Waiting ${ANTI_BAN_DELAY_MS / 1000}s before next message...`);
      await delay(ANTI_BAN_DELAY_MS);
    }

  } catch (err) {
    console.error("Matchmaking pipeline error:", err);
  }
};

// ─── Create instant booking ───────────────────────────────────────────────────

exports.createInstantBooking = async (req, res) => {
  try {
    const {
      name, decorType, note, locationAddress,
      lat, lng, city, guestCount, eventType,
      selectedProductId, estimatedPrice,
    } = req.body;

    const userId   = req.user.id;
    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!name || !locationAddress || !city) {
      return res.status(400).json({
        success: false,
        message: "Name, address, and city are all required.",
      });
    }

    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid GPS coordinates are required.",
      });
    }

    // Radius level 1 — tighter search within the same city
    let nearbySellers = await Seller.find({
      city: { $regex: new RegExp(`^${city.trim()}$`, "i") },
      approved: true,
      blocked: false,
      isOnline: true,
      isAllocated: false,
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [longitude, latitude] },
          $maxDistance: METRO_INNER_RADIUS,
        },
      },
    }).limit(ABSOLUTE_MAX_BROADCAST_LIMIT);

    // Radius level 2 — wider search but still same city
    if (!nearbySellers.length) {
      nearbySellers = await Seller.find({
        city: { $regex: new RegExp(`^${city.trim()}$`, "i") },
        approved: true,
        blocked: false,
        isOnline: true,
        isAllocated: false,
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [longitude, latitude] },
            $maxDistance: METRO_MAX_CUTOFF,
          },
        },
      }).limit(ABSOLUTE_MAX_BROADCAST_LIMIT);
    }

    if (!nearbySellers.length) {
      return res.status(404).json({
        success: false,
        code: "NO_LOCAL_VENDORS",
        message: `No decorators are available in ${city} right now. Please try again shortly.`,
      });
    }

    // Multi-factor ranking: closer + higher-rated + premium sellers come first
    console.log(`\n🔍 Ranking ${nearbySellers.length} seller(s) in ${city.toUpperCase()}`);

    const rankedSellers = nearbySellers
      .map((seller) => {
        const [sellerLng, sellerLat] = seller.location.coordinates;
        const distanceM = haversineDistanceMeters(sellerLat, sellerLng, latitude, longitude);
        const rating    = seller.rating && seller.rating > 0 ? seller.rating : 1.0;
        const premiumMultiplier = seller.isPremium ? 0.80 : 1.0; // premium sellers effectively "closer"
        const score     = (distanceM * premiumMultiplier) / rating;

        console.log(
          `  • ${seller.name} | ${(distanceM / 1000).toFixed(2)} km | ` +
          `Rating: ${rating} | Premium: ${seller.isPremium ? 'Yes' : 'No'} | Score: ${score.toFixed(0)}`
        );

        return { id: seller._id, score };
      })
      .sort((a, b) => a.score - b.score);

    const routingQueue = rankedSellers.map((s) => s.id);

    const booking = await Booking.create({
      userId,
      bookingType: "instant",
      serviceDetails: { name, decorType, note, guestCount, eventType, city },
      pickupLocation: { address: locationAddress, coordinates: [longitude, latitude] },
      selectedProductId: selectedProductId || null,
      estimatedPrice: estimatedPrice || 0,
      routingQueue,
      currentRoutingIndex: 0,
    });

    // Run matchmaking in the background — don't block the HTTP response
    processMatchmakingPipeline(booking._id).catch((err) =>
      console.error("Background matchmaking error:", err)
    );

    return res.status(201).json({
      success: true,
      bookingId: booking._id,
      booking,
      message: "Booking created. Finding the best decorator nearby...",
    });

  } catch (err) {
    console.error("createInstantBooking error:", err);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};

// ─── Get user booking history ─────────────────────────────────────────────────

exports.getUserBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user.id })
      .populate("sellerId", "name businessPhone rating passportPhoto")
      .sort({ createdAt: -1 });

    return res.json({ success: true, bookings });
  } catch (err) {
    console.error("getUserBookings error:", err);
    return res.status(500).json({ success: false, message: "Could not fetch booking history." });
  }
};

// ─── Create scheduled booking ─────────────────────────────────────────────────

exports.createScheduledBooking = async (req, res) => {
  try {
    const { name, decorType, eventDate, timeSlot, locationAddress, lat, lng, guestCount, eventType } = req.body;
    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!name || !locationAddress || !eventDate || !timeSlot) {
      return res.status(400).json({ success: false, message: "Name, address, date, and time are required." });
    }

    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({ success: false, message: "Valid GPS coordinates are required." });
    }

    const booking = await Booking.create({
      userId: req.user.id,
      bookingType: "scheduled",
      scheduledTime: new Date(`${eventDate} ${timeSlot}`),
      serviceDetails: { name, decorType, guestCount, eventType },
      pickupLocation: { address: locationAddress, coordinates: [longitude, latitude] },
    });

    return res.status(201).json({ success: true, booking });
  } catch (err) {
    console.error("createScheduledBooking error:", err);
    return res.status(500).json({ success: false, message: "Could not create scheduled booking." });
  }
};

// ─── Get booking status ───────────────────────────────────────────────────────

exports.getBookingStatus = async (req, res) => {
  try {
    const { bookingId } = req.params;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID." });
    }

    const booking = await Booking.findById(bookingId)
      .populate("sellerId", "name businessName email city rating completedBookings isPremium passportPhoto profileImage")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    if (String(booking.userId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "You do not have access to this booking." });
    }

    return res.json({ success: true, booking });
  } catch (err) {
    console.error("getBookingStatus error:", err);
    return res.status(500).json({ success: false, message: "Could not fetch booking status." });
  }
};

// ─── Seller accept booking ────────────────────────────────────────────────────

exports.acceptBooking = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { bookingId }    = req.params;
    const querySellerId    = req.query.sellerId;
    const sellerId         = (querySellerId && isValidObjectId(querySellerId)) ? querySellerId : req.seller?.id;

    if (!sellerId || !isValidObjectId(bookingId)) {
      return res.status(401).send(errorPage("Invalid seller or booking ID."));
    }

    let resultBooking = null;

    await session.withTransaction(async () => {
      const booking = await Booking.findOne({
        _id: bookingId,
        status: "pending_allocation",
        offerExpiresAt: { $gt: new Date() },
      }).session(session);

      if (!booking) {
        const err = new Error("This offer has already been taken or has expired.");
        err.code = "OFFER_UNAVAILABLE";
        throw err;
      }

      const seller = await Seller.findOneAndUpdate(
        { _id: sellerId, isAllocated: false },
        { isAllocated: true },
        { new: true, session }
      );

      if (!seller) {
        const err = new Error("You are currently assigned to another booking.");
        err.code = "SELLER_BUSY";
        throw err;
      }

      booking.sellerId         = sellerId;
      booking.status           = "seller_assigned";
      booking.acceptedAt       = new Date();
      booking.notifiedSellerId = null;
      booking.offerExpiresAt   = null;

      await booking.save({ session });
      resultBooking = booking;
    });

    // JSON response (dashboard / API call)
    if (req.xhr || req.headers.accept?.includes('application/json') || !req.query.sellerId) {
      return res.json({ success: true, message: "Booking accepted!", booking: resultBooking });
    }

    // HTML response (WhatsApp link click)
    return res.send(successPage(bookingId));

  } catch (err) {
    console.error("acceptBooking error:", err);
    const msg = err.code ? err.message : "Could not accept this booking. Please try again.";

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(409).json({ success: false, message: msg });
    }
    return res.status(409).send(warningPage(msg));
  } finally {
    await session.endSession();
  }
};

// ─── Seller reject booking ────────────────────────────────────────────────────

exports.rejectBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const querySellerId = req.query.sellerId;
    const sellerId      = (querySellerId && isValidObjectId(querySellerId)) ? querySellerId : req.seller?.id;

    if (!sellerId || !isValidObjectId(bookingId)) {
      return res.status(401).send(errorPage("Invalid seller or booking ID."));
    }

    const booking = await Booking.findById(bookingId);

    if (booking && booking.status === "pending_allocation") {
      await Booking.findByIdAndUpdate(bookingId, { $pull: { routingQueue: sellerId } });
      console.log(`↩️ Seller ${sellerId} rejected booking ${bookingId}. Moving to next in queue.`);

      // Re-run pipeline for remaining sellers in background
      processMatchmakingPipeline(bookingId).catch((err) =>
        console.error("Pipeline error after rejection:", err)
      );
    }

    return res.send(rejectPage());
  } catch (err) {
    console.error("rejectBooking error:", err);
    return res.status(500).send("<h1>Something went wrong. Please close this window.</h1>");
  }
};

// ─── Complete booking ─────────────────────────────────────────────────────────

exports.completeBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID." });
    }

    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: "seller_assigned" },
      { status: "completed", completedAt: new Date() },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found or cannot be completed." });
    }

    await Seller.findByIdAndUpdate(booking.sellerId, {
      isAllocated: false,
      $inc: { completedBookings: 1 },
    });

    return res.json({ success: true, booking });
  } catch (err) {
    console.error("completeBooking error:", err);
    return res.status(500).json({ success: false, message: "Could not complete this booking." });
  }
};

// ─── Seller cancel booking ────────────────────────────────────────────────────

exports.sellerCancelBooking = async (req, res) => {
  try {
    const { bookingId }        = req.params;
    const { cancellationReason } = req.body;
    const sellerId             = req.seller.id;

    const booking = await Booking.findOne({ _id: bookingId, sellerId });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found for your account." });
    }

    if (booking.status === 'completed') {
      return res.status(400).json({ success: false, message: "Completed bookings cannot be cancelled." });
    }

    booking.status             = 'cancelled';
    booking.cancellationDetails = {
      cancelledBy: 'seller',
      reason: cancellationReason || 'Cancelled by decorator.',
      timestamp: new Date(),
    };
    await booking.save();

    await Seller.findByIdAndUpdate(sellerId, { isAllocated: false });

    return res.json({ success: true, message: "Booking cancelled successfully." });
  } catch (err) {
    console.error("sellerCancelBooking error:", err);
    return res.status(500).json({ success: false, message: "Could not cancel this booking." });
  }
};

// ─── Customer cancel booking ──────────────────────────────────────────────────

exports.cancelBooking = async (req, res) => {
  try {
    const { bookingId }        = req.params;
    const { cancellationReason } = req.body;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID." });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    if (["completed", "cancelled"].includes(booking.status)) {
      return res.status(409).json({ success: false, message: `This booking is already ${booking.status}.` });
    }

    const hadSeller = booking.status === "seller_assigned" && booking.sellerId;

    booking.status           = "cancelled";
    booking.cancelledAt      = new Date();
    booking.cancellationReason = cancellationReason || "";
    booking.notifiedSellerId = null;
    booking.offerExpiresAt   = null;
    await booking.save();

    if (hadSeller) {
      await Seller.findByIdAndUpdate(booking.sellerId, { isAllocated: false });
    }

    return res.json({ success: true, booking });
  } catch (err) {
    console.error("cancelBooking error:", err);
    return res.status(500).json({ success: false, message: "Could not cancel this booking." });
  }
};

// ─── Get seller's assigned bookings ──────────────────────────────────────────

exports.getSellerAssignedBookings = async (req, res) => {
  try {
    const sellerId = req.seller.id;

    if (!isValidObjectId(sellerId)) {
      return res.status(400).json({ success: false, message: "Invalid seller account." });
    }

    const bookings = await Booking.find({ sellerId })
      .populate("userId", "name phone email")
      .populate("selectedProductId", "name price image instantDeliveryTime")
      .sort({ createdAt: -1 });

    return res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    console.error("getSellerAssignedBookings error:", err);
    return res.status(500).json({ success: false, message: "Could not fetch your bookings." });
  }
};

// Export for use in scheduled task runners if needed
exports.processMatchmakingPipeline = processMatchmakingPipeline;

// ─── HTML page helpers ────────────────────────────────────────────────────────

const baseHtml = (content) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[#121214] text-gray-100 flex items-center justify-center min-h-screen p-4 font-sans">
  ${content}
</body>
</html>`;

const successPage = (bookingId) => baseHtml(`
  <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-emerald-500/20 shadow-2xl text-center space-y-6">
    <div class="w-16 h-16 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mx-auto text-3xl animate-bounce">🎉</div>
    <div class="space-y-2">
      <h1 class="text-2xl font-bold text-emerald-400">Job Accepted!</h1>
      <p class="text-gray-400 text-sm">This booking has been locked to your profile. The customer will be notified.</p>
    </div>
    <div class="p-4 bg-[#121214] rounded-xl border border-gray-800 text-left space-y-2">
      <p class="text-xs text-gray-500 uppercase font-semibold tracking-wider">Booking ID</p>
      <p class="font-mono text-xs text-gray-300 break-all">${bookingId}</p>
    </div>
    <p class="text-xs text-gray-500">You can close this window now.</p>
    <button onclick="window.close()" class="w-full bg-emerald-500 hover:bg-emerald-600 text-[#121214] font-semibold py-3 px-4 rounded-xl transition text-sm">Close</button>
  </div>`);

const warningPage = (message) => baseHtml(`
  <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-amber-500/20 shadow-2xl text-center space-y-6">
    <div class="w-16 h-16 bg-amber-500/10 text-amber-400 rounded-full flex items-center justify-center mx-auto text-3xl">⏳</div>
    <div class="space-y-2">
      <h1 class="text-xl font-bold text-amber-400">Not Available</h1>
      <p class="text-gray-400 text-sm">${message}</p>
    </div>
    <button onclick="window.close()" class="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold py-3 px-4 rounded-xl transition text-sm">Close</button>
  </div>`);

const errorPage = (message) => baseHtml(`
  <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-red-500/20 shadow-2xl text-center space-y-4">
    <div class="text-3xl text-red-400">❌</div>
    <h1 class="text-xl font-bold text-red-400">Something went wrong</h1>
    <p class="text-gray-400 text-sm">${message}</p>
  </div>`);

const rejectPage = () => baseHtml(`
  <div class="max-w-md w-full bg-[#1e1e24] rounded-2xl p-8 border border-gray-700 shadow-2xl text-center space-y-6">
    <div class="w-16 h-16 bg-gray-500/10 text-gray-400 rounded-full flex items-center justify-center mx-auto text-3xl">↩️</div>
    <div class="space-y-2">
      <h1 class="text-xl font-bold text-gray-300">Offer Declined</h1>
      <p class="text-gray-400 text-sm">No problem. We'll find another decorator for this job.</p>
    </div>
    <button onclick="window.close()" class="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold py-3 px-4 rounded-xl transition text-sm">Close</button>
  </div>`);
