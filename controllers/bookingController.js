const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Seller = require("../models/Seller");
const Product = require("../models/Product");
const Booking = require("../models/Booking");
const axios = require("axios");

exports.initWhatsApp = () => {
  console.log("ℹ️ initWhatsApp() called — this is now a no-op. WhatsApp messages are sent via the Meta Graph API (see sendJobOfferToSeller), not whatsapp-web.js.");
};

// ─── Configuration ────────────────────────────────────────────────────────────

const OFFER_TIMEOUT_MS             = parseInt(process.env.MATCHMAKING_OFFER_TIMEOUT_MS, 10) || 60000;
const ABSOLUTE_MAX_BROADCAST_LIMIT = parseInt(process.env.ABSOLUTE_MAX_BROADCAST_LIMIT, 10) || 12;
const ANTI_BAN_DELAY_MS            = parseInt(process.env.ANTI_BAN_DELAY_MS, 10)            || 40000;
const APP_BASE_URL                 = process.env.APP_BASE_URL || "https://decoryy.com";
const API_BASE_URL                 = process.env.API_BASE_URL || "https://api.decoryy.com/api/bookings";
const TRACKING_TOKEN_SECRET        = process.env.TRACKING_TOKEN_SECRET; // REQUIRED — set in .env
const TRACKING_TOKEN_EXPIRY        = process.env.TRACKING_TOKEN_EXPIRY || "24h";

// Statuses that mean "this job is decided, stop offering it to other sellers"
const ACTIVE_STATUSES = ["seller_assigned", "accepted", "cancelled", "completed"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isValidCoordinate = (lat, lng) =>
  typeof lat === "number" && typeof lng === "number" &&
  !Number.isNaN(lat) && !Number.isNaN(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Normalise an Indian phone number to WhatsApp ID format (91XXXXXXXXXX@c.us)
const toWhatsAppId = (rawPhone) => {
  const clean = rawPhone.trim().replace(/[\s\-()+]/g, "");
  const withCountryCode = clean.length === 10 ? `91${clean}` : clean;
  return `${withCountryCode}@c.us`;
};

const normalizePhone = (rawPhone) => {
  const clean = rawPhone.replace(/\D/g, "");
  return clean.length === 10 ? `91${clean}` : clean;
};

// ─── Download image to base64 via axios (NO Puppeteer involvement) ────────────

const downloadImageAsBase64 = async (url) => {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Decoryy/1.0)',
    },
  });

  const mimeType = response.headers['content-type']?.split(';')[0]?.trim() || 'image/jpeg';
  const base64   = Buffer.from(response.data, 'binary').toString('base64');
  return { base64, mimeType };
};

const toWhatsAppSafeImageUrl = (cloudinaryUrl) => {
  if (!cloudinaryUrl || !cloudinaryUrl.includes("/upload/")) return cloudinaryUrl;
  return cloudinaryUrl.replace("/upload/", "/upload/f_jpg,q_auto/");
};

// ─── Tracking token (JWT) ──────────────────────────────────────────────────────
// This is what goes into the "Track Order" button URL suffix:
// https://decoryy.com/track/<token>

const generateTrackingToken = (bookingId) => {
  if (!TRACKING_TOKEN_SECRET) {
    throw new Error("TRACKING_TOKEN_SECRET is not set in environment variables.");
  }
  return jwt.sign({ bookingId: String(bookingId) }, TRACKING_TOKEN_SECRET, {
    expiresIn: TRACKING_TOKEN_EXPIRY,
  });
};

const verifyTrackingToken = (token) => {
  if (!TRACKING_TOKEN_SECRET) {
    throw new Error("TRACKING_TOKEN_SECRET is not set in environment variables.");
  }
  return jwt.verify(token, TRACKING_TOKEN_SECRET); // throws if invalid/expired
};

// Formats a JS Date into "DD Mon YYYY, hh:mm AM/PM" for the {{4}} template variable
const formatEventDateTime = (date) => {
  if (!date) return "To be confirmed";
  return new Date(date).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// ─── WhatsApp job offer dispatcher ───────────────────────────────────────────

const sendJobOfferToSeller = async (seller, booking) => {
  try {

    const rawPhone = seller.businessPhone.replace(/\D/g, "");
    const phone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;

    const product = booking.selectedProductId;

    const resolvedImageUrl = toWhatsAppSafeImageUrl(product.image?.url || product.image);
    console.log("🖼️ Header image URL being sent:", resolvedImageUrl);

    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: "decoryy",
          language: {
            code: "en"
          },
          components: [
            {
              type: "header",
              parameters: [
                {
                  type: "image",
                  image: {
                    link: resolvedImageUrl
                  }
                }
              ]
            },
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  parameter_name: "seller_name",
                  text: seller.name
                },
                {
                  type: "text",
                  parameter_name: "customer_name",
                  text: booking.serviceDetails.name
                },
                {
                  type: "text",
                  parameter_name: "product_name",
                  text: product.name
                },
                {
                  type: "text",
                  parameter_name: "price",
                  text: product.price.toString()
                },
                {
                  type: "text",
                  parameter_name: "delivery_time",
                  text: product.instantDeliveryTime || "30 mins"
                },
                {
                  type: "text",
                  parameter_name: "venue_address",
                  text: booking.pickupLocation.address
                }
              ]
            },
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [
                {
                  type: "text",
                  text: `${booking._id}?sellerId=${seller._id}`
                }
              ]
            },
            {
              type: "button",
              sub_type: "url",
              index: "1",
              parameters: [
                {
                  type: "text",
                  text: `${booking._id}?sellerId=${seller._id}`
                }
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Template sent:", JSON.stringify(response.data, null, 2));

    const acceptUrl  = `${API_BASE_URL}/accept/${booking._id}?sellerId=${seller._id}`;
    const declineUrl = `${API_BASE_URL}/reject/${booking._id}?sellerId=${seller._id}`;
    console.log(`🔗 Accept link:  ${acceptUrl}`);
    console.log(`🔗 Decline link: ${declineUrl}`);

    return true;

  } catch(err){

    console.log(err.response?.data || err.message);

    return false;
  }
};

// ─── WhatsApp: notify customer that a vendor accepted (decoryy_customer_vendor_assigned) ─

const sendVendorAssignedToCustomer = async (booking, seller) => {
  try {
    if (!booking.customerPhone) {
      console.log(`⚠️ Booking ${booking._id} has no customerPhone — skipping customer WhatsApp.`);
      return false;
    }

    const toPhone = normalizePhone(booking.customerPhone);
    const eventDateTime = formatEventDateTime(booking.scheduledTime || booking.createdAt);

    console.log(`📨 [customer-notify] Sending to ${toPhone} for booking ${booking._id}`);

    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "template",
        template: {
          name: "decoryy_customer_vendor",
          language: {
            code: "en"
          },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: booking.serviceDetails.name },                // {{1}} Customer Name
                { type: "text", text: seller.name },                                // {{2}} Vendor Name
                { type: "text", text: booking.selectedProductId?.name || "Decor" },  // {{3}} Service Name
                { type: "text", text: seller.businessPhone || "N/A" },              // {{4}} Vendor Contact
                { type: "text", text: booking.selectedProductId?.instantDeliveryTime },                              // {{5}} Event Date & Time
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Customer vendor-assigned template sent:", JSON.stringify(response.data, null, 2));
    return true;

  } catch (err) {
    console.log("❌ Customer vendor-assigned template FAILED:", err.response?.data || err.message);
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

    console.log(`📡 Sending offers to ${dedupedQueue.length} decorator(s) in ${updatedBooking.pickupLocation?.city || 'city'}, ${updatedBooking.pickupLocation?.state || 'state'}...`);

    for (const seller of dedupedQueue) {
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
// Seller matching: sellers no longer carry GPS coordinates (the Seller
// schema is address-based only — state / city / address / pincode), so
// matching is done by STATE + CITY first (both exact match, case-insensitive
// — this is a hard filter, not just a ranking signal, so a job in
// "Pune, Maharashtra" can never be routed to a same-named city in a
// different state). Within that state+city pool, sellers whose PINCODE
// matches the customer's pincode are ranked ahead of the rest. Rating and
// premium status break remaining ties. This replaces the old $near
// geospatial query, which relied on a `location` field the Seller model
// no longer has.

exports.createInstantBooking = async (req, res) => {
  try {
    const {
      name, note, locationAddress,
      lat, lng, state, city, pincode, guestCount, eventType,
      selectedProductId, estimatedPrice, customerPhone,
    } = req.body;

    const userId    = req.user.id;
    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lng);

    // State, city, and pincode are all required server-side now — pincode
    // was previously read but never enforced, which meant a client that
    // skipped the frontend validation (or hit the API directly) could still
    // create a booking with no pincode. locationAddress stays required too.
    if (!name || !locationAddress || !state || !city || !pincode) {
      return res.status(400).json({
        success: false,
        message: "Name, address, state, city, and pincode are all required.",
      });
    }

    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid GPS coordinates are required.",
      });
    }

    const normalizedState   = state.trim();
    const normalizedCity    = city.trim();
    const normalizedPincode = pincode.toString().trim();

    if (!/^\d{6}$/.test(normalizedPincode)) {
      return res.status(400).json({
        success: false,
        message: "Pincode must be a valid 6-digit number.",
      });
    }

    const statePattern = new RegExp(`^${escapeRegex(normalizedState)}$`, "i");
    const cityPattern  = new RegExp(`^${escapeRegex(normalizedCity)}$`, "i");

    // Over-fetch a bit before ranking/trimming to the broadcast limit, so we
    // have enough candidates to properly rank pincode matches to the front.
    const localSellers = await Seller.find({
      approved: true,
      blocked: false,
      isOnline: true,
      isAllocated: false,
      state: statePattern,
      city: cityPattern,
    }).limit(ABSOLUTE_MAX_BROADCAST_LIMIT * 3);

    if (!localSellers.length) {
      return res.status(404).json({
        success: false,
        code: "NO_LOCAL_VENDORS",
        message: `No decorators are available in ${normalizedCity}, ${normalizedState} right now. Please try again shortly.`,
      });
    }

    console.log(
      `\n🔍 Ranking ${localSellers.length} seller(s) in ${normalizedCity.toUpperCase()}, ${normalizedState.toUpperCase()} (pincode ${normalizedPincode})`
    );

    const rankedSellers = localSellers
      .map((seller) => {
        const rating = seller.rating && seller.rating > 0 ? seller.rating : 1.0;
        const pincodeMatch = seller.pincode === normalizedPincode;
        const premiumBonus = seller.isPremium ? 0.2 : 0;
        // Lower score wins. A pincode match gets a large fixed head start
        // over non-matches; rating and premium status break remaining ties.
        const score = (pincodeMatch ? 0 : 1000) - rating - premiumBonus;

        console.log(
          `  • ${seller.name} | Pincode: ${seller.pincode || '—'}${pincodeMatch ? ' ✅ match' : ''} | ` +
          `Rating: ${rating} | Premium: ${seller.isPremium ? 'Yes' : 'No'} | Score: ${score.toFixed(2)}`
        );

        return { id: seller._id, score };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, ABSOLUTE_MAX_BROADCAST_LIMIT);

    const routingQueue = rankedSellers.map((s) => s.id);

    const booking = await Booking.create({
      userId,
      bookingType: "instant",
      serviceDetails: { name, note, guestCount, eventType },
      pickupLocation: {
        address: locationAddress,
        coordinates: [longitude, latitude],
        state: normalizedState,
        city: normalizedCity,
        pincode: normalizedPincode,
      },
      selectedProductId: selectedProductId || null,
      estimatedPrice: estimatedPrice || 0,
      customerPhone: customerPhone || "",
      routingQueue,
      currentRoutingIndex: 0,
    });

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

// ─── Update vendor GPS location (called every few seconds from seller's phone) ─

exports.updateVendorLocation = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { lat, lng } = req.body;

    if (!isValidObjectId(bookingId) || !isValidCoordinate(lat, lng)) {
      return res.status(400).json({ success: false, message: "Invalid booking id or coordinates." });
    }

    await Booking.findByIdAndUpdate(bookingId, {
      vendorLocation: { lat, lng, updatedAt: new Date() },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("updateVendorLocation error:", err);
    return res.status(500).json({ success: false });
  }
};

// ─── Get vendor location by raw bookingId (used internally / seller side) ────

exports.getVendorLocation = async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id." });
    }

    const booking = await Booking.findById(bookingId).select("vendorLocation status");
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    return res.json({ success: true, location: booking.vendorLocation || null, status: booking.status });
  } catch (err) {
    console.error("getVendorLocation error:", err);
    return res.status(500).json({ success: false });
  }
};

// ─── Get vendor location by tracking token (used by the customer's public track page) ─
// This is what https://decoryy.com/track/<token> calls.

exports.getVendorLocationByToken = async (req, res) => {
  try {
    const { token } = req.params;

    let payload;
    try {
      payload = verifyTrackingToken(token);
    } catch (err) {
      return res.status(401).json({ success: false, message: "This tracking link is invalid or has expired." });
    }

    const booking = await Booking.findById(payload.bookingId)
      .select("vendorLocation status serviceDetails sellerId")
      .populate("sellerId", "name businessPhone");

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    return res.json({
      success: true,
      location: booking.vendorLocation || null,
      status: booking.status,
      vendor: booking.sellerId ? { name: booking.sellerId.name, phone: booking.sellerId.businessPhone } : null,
    });
  } catch (err) {
    console.error("getVendorLocationByToken error:", err);
    return res.status(500).json({ success: false });
  }
};

// ─── Create scheduled booking ─────────────────────────────────────────────────

exports.createScheduledBooking = async (req, res) => {
  try {
    const { name, eventDate, timeSlot, locationAddress, lat, lng, guestCount, eventType } = req.body;
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
      serviceDetails: { name, guestCount, eventType },
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

// ─── Seller accept booking (seller taps the WhatsApp button link) ────────────
// NOTE: this used to be defined TWICE in the file. The second definition was
// silently overwriting the first (the one that actually sent WhatsApp
// messages), which is why nothing fired after acceptance. Merged into one.

exports.acceptBooking = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { bookingId }  = req.params;
    const querySellerId  = req.query.sellerId;
    const sellerId       = (querySellerId && isValidObjectId(querySellerId)) ? querySellerId : req.seller?.id;

    console.log(`\n➡️  [accept] Incoming accept request | booking=${bookingId} seller=${sellerId}`);

    if (!sellerId || !isValidObjectId(bookingId)) {
      console.log("❌ [accept] Invalid seller or booking id.");
      return res.status(401).send(errorPage("Invalid seller or booking ID."));
    }

    let resultBooking = null;
    let resultSeller = null;

    await session.withTransaction(async () => {
      const booking = await Booking.findOne({
        _id: bookingId,
        status: "pending_allocation",
        offerExpiresAt: { $gt: new Date() },
      }).session(session);

      if (!booking) {
        console.log("🛑 [accept] Offer already taken or expired.");
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
        console.log("🛑 [accept] Seller already busy on another booking.");
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
      resultSeller  = seller;

      console.log(`✅ [accept] Booking ${bookingId} locked to seller ${seller.name} (${seller._id})`);
    });

    // Populate product info needed for the templates, then fire both WhatsApp
    // notifications in the background — don't block the HTTP response the
    // seller's browser is waiting on.
    Booking.findById(resultBooking._id)
      .populate("selectedProductId")
      .then((populatedBooking) => {
        console.log(`📨 [accept] Sending post-accept WhatsApp message to customer for booking ${bookingId}...`);
        // Vendor no longer gets a WhatsApp message here — only the customer is notified.
        return sendVendorAssignedToCustomer(populatedBooking, resultSeller); // → customer: "Vendor Assigned" template (no track button)
      })
      .then((customerOk) => {
        console.log(`📨 [accept] Customer message sent: ${customerOk}`);
      })
      .catch((err) => console.error("❌ [accept] Post-accept notify error:", err));

    if (req.xhr || req.headers.accept?.includes('application/json') || !req.query.sellerId) {
      return res.json({ success: true, message: "Booking accepted!", booking: resultBooking });
    }

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
    const { bookingId }          = req.params;
    const { cancellationReason } = req.body;
    const sellerId               = req.seller.id;

    const booking = await Booking.findOne({ _id: bookingId, sellerId });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found for your account." });
    }

    if (booking.status === 'completed') {
      return res.status(400).json({ success: false, message: "Completed bookings cannot be cancelled." });
    }

    booking.status              = 'cancelled';
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
    const { bookingId }          = req.params;
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

    booking.status             = "cancelled";
    booking.cancelledAt        = new Date();
    booking.cancellationReason = cancellationReason || "";
    booking.notifiedSellerId   = null;
    booking.offerExpiresAt     = null;
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