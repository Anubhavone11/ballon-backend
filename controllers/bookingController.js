const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Seller = require("../models/Seller");
const Product = require("../models/Product");
const Booking = require("../models/Booking");
const axios = require("axios");
const sharp = require("sharp");
const FormData = require("form-data");

exports.initWhatsApp = () => {
  console.log("ℹ️ initWhatsApp() called — WhatsApp messages are sent via Meta Graph API.");
};

// ─── Configuration ────────────────────────────────────────────────────────────

const OFFER_TIMEOUT_MS             = parseInt(process.env.MATCHMAKING_OFFER_TIMEOUT_MS, 10) || 60000;
const ABSOLUTE_MAX_BROADCAST_LIMIT = parseInt(process.env.ABSOLUTE_MAX_BROADCAST_LIMIT, 10) || 12;
const ANTI_BAN_DELAY_MS            = parseInt(process.env.ANTI_BAN_DELAY_MS, 10)            || 40000;
const APP_BASE_URL                 = process.env.APP_BASE_URL || "https://decoryy.com";
const API_BASE_URL                 = process.env.API_BASE_URL || "https://api.decoryy.com/api/bookings";
const TRACKING_TOKEN_SECRET        = process.env.TRACKING_TOKEN_SECRET;
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

const normalizePhone = (rawPhone) => {
  const clean = String(rawPhone).replace(/\D/g, "");
  return clean.length === 10 ? `91${clean}` : clean;
};

// ─── Upload image to Meta ─────────────────────────────────────────────────────

const uploadImageToMeta = async (imageUrl) => {
  try {
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const jpegBuffer = await sharp(response.data).jpeg().toBuffer();

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", jpegBuffer, { filename: "image.jpg", contentType: "image/jpeg" });

    const metaResponse = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WA_PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        },
      }
    );

    return metaResponse.data.id;
  } catch (error) {
    console.error("❌ Media upload failed:", error?.response?.data || error.message);
    return null;
  }
};

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

    const product = booking.selectedProductId || {};
    const rawImageUrl = product.image?.url || product.image;

    const mediaId = await uploadImageToMeta(rawImageUrl);

    const headerParameter = mediaId
      ? { type: "image", image: { id: mediaId } }
      : {
          type: "image",
          image: {
            link: "https://upload.wikimedia.org/wikipedia/commons/e/e1/FullMoon2010.jpg",
          },
        };

    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: "decoryy",
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [headerParameter],
            },
            {
              type: "body",
              parameters: [
                { type: "text", parameter_name: "seller_name", text: seller.name || "Vendor" },
                { type: "text", parameter_name: "customer_name", text: booking.serviceDetails?.name || "Customer" },
                { type: "text", parameter_name: "product_name", text: product.name || "Decoration Package" },
                { type: "text", parameter_name: "price", text: String(product.price || booking.estimatedPrice || "0") },
                { type: "text", parameter_name: "delivery_time", text: product.instantDeliveryTime || "30 mins" },
                { type: "text", parameter_name: "venue_address", text: booking.pickupLocation?.address || "Address provided upon acceptance" },
              ],
            },
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [{ type: "text", text: `${booking._id}?sellerId=${seller._id}` }],
            },
            {
              type: "button",
              sub_type: "url",
              index: "1",
              parameters: [{ type: "text", text: `${booking._id}?sellerId=${seller._id}` }],
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Job offer template sent successfully:", JSON.stringify(response.data, null, 2));

    const acceptUrl = `${API_BASE_URL}/accept/${booking._id}?sellerId=${seller._id}`;
    const declineUrl = `${API_BASE_URL}/reject/${booking._id}?sellerId=${seller._id}`;
    console.log(`🔗 Accept link:  ${acceptUrl}`);
    console.log(`🔗 Decline link: ${declineUrl}`);

    return true;
  } catch (err) {
    console.error("❌ sendJobOfferToSeller failed:", err.response?.data || err.message);
    return false;
  }
};

// ─── WhatsApp: notify customer that a vendor accepted ─────────────────────────

const sendVendorAssignedToCustomer = async (booking, seller) => {
  try {
    if (!booking.customerPhone) {
      console.log(`⚠️ Booking ${booking._id} has no customerPhone — skipping customer WhatsApp.`);
      return false;
    }

    const toPhone = normalizePhone(booking.customerPhone);

    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "template",
        template: {
          name: "decoryy_customer_vendor",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: booking.serviceDetails?.name || "Customer" },
                { type: "text", text: seller.name || "Decorator" },
                { type: "text", text: booking.selectedProductId?.name || "Decor" },
                { type: "text", text: seller.businessPhone || "N/A" },
                { type: "text", text: booking.selectedProductId?.instantDeliveryTime || "30-60 mins" },
              ],
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
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
    const booking = await Booking.findById(bookingId).populate("selectedProductId");
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
    ).populate("selectedProductId");

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

    for (const seller of dedupedQueue) {
      const current = await Booking.findById(bookingId).select("status").lean();
      if (current && ACTIVE_STATUSES.includes(current.status)) {
        console.log(`🛑 Booking ${bookingId} already taken. Stopping queue.`);
        break;
      }

      await sendJobOfferToSeller(seller, updatedBooking);
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
      name, note, locationAddress,
      lat, lng, state, city, pincode, guestCount, eventType,
      selectedProductId, estimatedPrice, customerPhone,
    } = req.body;

    const userId    = req.user.id;
    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lng);

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

    const rankedSellers = localSellers
      .map((seller) => {
        const rating = seller.rating && seller.rating > 0 ? seller.rating : 1.0;
        const pincodeMatch = seller.pincode === normalizedPincode;
        const premiumBonus = seller.isPremium ? 0.2 : 0;
        const score = (pincodeMatch ? 0 : 1000) - rating - premiumBonus;
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

// ─── Seller accept booking ────────────────────────────────────────────────────

exports.acceptBooking = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { bookingId }  = req.params;
    const querySellerId  = req.query.sellerId;
    const sellerId       = (querySellerId && isValidObjectId(querySellerId)) ? querySellerId : req.seller?.id;

    if (!sellerId || !isValidObjectId(bookingId)) {
      return res.status(401).send(errorPage("Invalid seller or booking identifier."));
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
        const err = new Error("This decoration request has already been assigned to another vendor or has expired.");
        err.code = "OFFER_UNAVAILABLE";
        throw err;
      }

      const seller = await Seller.findOneAndUpdate(
        { _id: sellerId, isAllocated: false },
        { isAllocated: true },
        { new: true, session }
      );

      if (!seller) {
        const err = new Error("You are already active on another live booking.");
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
    });

    const populatedBooking = await Booking.findById(resultBooking._id)
      .populate("selectedProductId")
      .lean();

    sendVendorAssignedToCustomer(populatedBooking, resultSeller).catch((err) =>
      console.error("❌ Customer post-accept notification error:", err)
    );

    if (req.xhr || req.headers.accept?.includes("application/json") || !req.query.sellerId) {
      return res.json({ success: true, message: "Booking accepted!", booking: populatedBooking });
    }

    return res.send(successPage(populatedBooking, resultSeller));

  } catch (err) {
    console.error("acceptBooking error:", err);
    const msg = err.code ? err.message : "Could not accept this booking. Please try again.";

    if (req.xhr || req.headers.accept?.includes("application/json")) {
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
      return res.status(401).send(errorPage("Invalid seller or booking identifier."));
    }

    const booking = await Booking.findById(bookingId);

    if (booking && booking.status === "pending_allocation") {
      await Booking.findByIdAndUpdate(bookingId, { $pull: { routingQueue: sellerId } });
      processMatchmakingPipeline(bookingId).catch((err) =>
        console.error("Pipeline error after rejection:", err)
      );
    }

    return res.send(rejectPage());
  } catch (err) {
    console.error("rejectBooking error:", err);
    return res.status(500).send(errorPage("Something went wrong while processing your rejection."));
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

    if (booking.status === "completed") {
      return res.status(400).json({ success: false, message: "Completed bookings cannot be cancelled." });
    }

    booking.status              = "cancelled";
    booking.cancellationDetails = {
      cancelledBy: "seller",
      reason: cancellationReason || "Cancelled by decorator.",
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

exports.getVendorLocationByToken = async (req, res) => {
  try {
    const { token } = req.params;
    let payload;
    try {
      payload = jwt.verify(token, TRACKING_TOKEN_SECRET);
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

exports.processMatchmakingPipeline = processMatchmakingPipeline;

// ─── Decoryy partner pages (accept / decline / unavailable / error) ───────────

// Escape anything that ends up inside HTML (vendor/customer text is user input).
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatINR = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0 ? `₹${n.toLocaleString("en-IN")}` : "";
};

const ICONS = {
  success:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  neutral:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12h12"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.2v.1"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 16H3L12 4z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/></svg>',
};

const baseHtml = (content, title = "Decoryy Partner") => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f5f5f4;
      --surface: #ffffff;
      --ink: #1c1917;
      --ink-2: #57534e;
      --ink-3: #a8a29e;
      --line: #e7e5e4;
      --brand: #e8a200;
      --brand-ink: #1c1917;
      --ok: #15803d;
      --ok-bg: #dcfce7;
      --warn: #b45309;
      --warn-bg: #fef3c7;
      --bad: #b91c1c;
      --bad-bg: #fee2e2;
      --muted-bg: #f5f5f4;
    }
    * { box-sizing: border-box; margin: 0; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 15px;
      line-height: 1.5;
    }
    .topbar {
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }
    .topbar-inner {
      max-width: 520px;
      margin: 0 auto;
      padding: 14px 20px;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .logo { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
    .topbar span { font-size: 13px; color: var(--ink-3); }

    main { flex: 1; width: 100%; max-width: 520px; margin: 0 auto; padding: 24px 20px 40px; }

    .status { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 20px; }
    .status-icon {
      flex: none;
      width: 44px; height: 44px;
      border-radius: 50%;
      display: grid; place-items: center;
    }
    .status-icon.ok      { background: var(--ok-bg);   color: var(--ok); }
    .status-icon.neutral { background: #e7e5e4;        color: var(--ink-2); }
    .status-icon.warn    { background: var(--warn-bg); color: var(--warn); }
    .status-icon.bad     { background: var(--bad-bg);  color: var(--bad); }
    h1 { font-size: 20px; line-height: 1.3; font-weight: 700; letter-spacing: -0.01em; }
    .lede { margin-top: 4px; color: var(--ink-2); font-size: 14px; }

    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      margin-bottom: 16px;
    }
    .item { display: flex; gap: 14px; align-items: center; padding: 14px; }
    .item img {
      width: 64px; height: 64px;
      border-radius: 6px;
      object-fit: cover;
      background: var(--muted-bg);
      flex: none;
    }
    .item-name { font-weight: 600; }
    .item-price { color: var(--ink-2); font-size: 14px; }

    .rows { padding: 4px 14px; }
    .row { padding: 12px 0; border-bottom: 1px solid var(--line); }
    .row:last-child { border-bottom: 0; }
    .row dt { font-size: 13px; color: var(--ink-3); margin-bottom: 2px; }
    .row dd { font-size: 15px; font-weight: 500; overflow-wrap: anywhere; }
    .panel-head { padding: 12px 14px; border-bottom: 1px solid var(--line); font-size: 13px; font-weight: 600; color: var(--ink-2); }

    .actions { display: grid; gap: 10px; margin-top: 4px; }
    .btn {
      display: flex; align-items: center; justify-content: center;
      min-height: 46px;
      padding: 0 16px;
      border-radius: 8px;
      font: inherit; font-weight: 600;
      text-decoration: none;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink);
    }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
    .btn:focus-visible, .link:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
    .btn:active { filter: brightness(0.96); }
    .link { text-align: center; color: var(--ink-2); font-size: 14px; padding: 8px; }

    .note { margin-top: 18px; font-size: 13px; color: var(--ink-3); }

    footer { padding: 16px 20px 24px; text-align: center; font-size: 12px; color: var(--ink-3); }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="logo">Decoryy</div>
      <span>Partner</span>
    </div>
  </header>
  <main>${content}</main>
  <footer>© ${new Date().getFullYear()} Decoryy</footer>
</body>
</html>`;

const statusBlock = (tone, icon, heading, text) => `
  <div class="status">
    <div class="status-icon ${tone}">${icon}</div>
    <div>
      <h1>${esc(heading)}</h1>
      <p class="lede">${text}</p>
    </div>
  </div>`;

const row = (label, value) =>
  value
    ? `<div class="row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
    : "";

// Accepted
const successPage = (booking, seller) => {
  const product = booking.selectedProductId || {};
  const productId = product._id || booking.selectedProductId;
  const productUrl = productId ? `${APP_BASE_URL}/product/${productId}` : `${APP_BASE_URL}/shop`;
  const image = product.image?.url || product.image || "";
  const price = formatINR(product.price || booking.estimatedPrice);
  const venue = booking.pickupLocation?.address || "";
  const customerName = booking.serviceDetails?.name || "";
  const customerPhone = booking.customerPhone ? normalizePhone(booking.customerPhone) : "";
  const shortId = String(booking._id).slice(-8).toUpperCase();

  const coords = booking.pickupLocation?.coordinates; // stored as [lng, lat]
  const directionsUrl =
    Array.isArray(coords) && coords.length === 2
      ? `https://www.google.com/maps/dir/?api=1&destination=${coords[1]},${coords[0]}`
      : "";

  return baseHtml(
    `
    ${statusBlock(
      "ok",
      ICONS.success,
      "Booking confirmed",
      `Thanks${seller?.name ? ", " + esc(seller.name) : ""}. This job is yours and the customer has been notified.`
    )}

    <section class="panel">
      <div class="item">
        ${image ? `<img src="${esc(image)}" alt="" width="64" height="64">` : ""}
        <div>
          <div class="item-name">${esc(product.name || "Decoration package")}</div>
          ${price ? `<div class="item-price">${esc(price)}</div>` : ""}
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">Booking details</div>
      <dl class="rows">
        ${row("Customer", customerName)}
        ${row("Set up within", product.instantDeliveryTime || "30–60 mins")}
        ${row("Venue address", venue)}
        ${row("Booking ID", shortId)}
      </dl>
    </section>

    <div class="actions">
      ${directionsUrl ? `<a class="btn primary" href="${esc(directionsUrl)}" target="_blank" rel="noopener">Get directions</a>` : ""}
      ${customerPhone ? `<a class="btn" href="tel:+${esc(customerPhone)}">Call customer</a>` : ""}
      <a class="link" href="${esc(productUrl)}" target="_blank" rel="noopener">View package details</a>
    </div>

    <p class="note">You won't receive new requests until this booking is marked complete.</p>
    `,
    "Booking confirmed · Decoryy Partner"
  );
};

// Declined
const rejectPage = () =>
  baseHtml(
    `
    ${statusBlock(
      "neutral",
      ICONS.neutral,
      "Request declined",
      "We've passed this booking to the next available decorator. You won't be offered it again."
    )}
    <p class="note">You can close this page.</p>
    `,
    "Request declined · Decoryy Partner"
  );

// Unavailable (taken / expired / busy)
const warningPage = (message) =>
  baseHtml(
    `
    ${statusBlock("warn", ICONS.warning, "This request is no longer available", esc(message))}
    <p class="note">New requests will reach you on WhatsApp as they come in.</p>
    `,
    "Request unavailable · Decoryy Partner"
  );

// Error
const errorPage = (message) =>
  baseHtml(
    `
    ${statusBlock("bad", ICONS.error, "We couldn't open this request", esc(message))}
    <p class="note">Open the link again from your WhatsApp message. If this keeps happening, contact Decoryy support.</p>
    `,
    "Something went wrong · Decoryy Partner"
  );