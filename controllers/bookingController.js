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
  const clean = rawPhone.replace(/\D/g, "");
  return clean.length === 10 ? `91${clean}` : clean;
};

// ─── Upload image to Meta ─────────────────────────────────────────────────────

const uploadImageToMeta = async (imageUrl) => {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
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

    if (req.xhr || req.headers.accept?.includes('application/json') || !req.query.sellerId) {
      return res.json({ success: true, message: "Booking accepted!", booking: populatedBooking });
    }

    return res.send(successPage(populatedBooking, resultSeller));

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
      return res.status(401).send(errorPage("Invalid seller or booking identifier."));
    }

    const booking = await Booking.findById(bookingId);

    if (booking && booking.status === "pending_allocation") {
      await Booking.findByIdAndUpdate(bookingId, { $pull: { routingQueue: sellerId } });
      processMatchmakingPipeline(bookingId).catch((err) =>
        console.error("Pipeline error after rejection:", err)
      );
    }

    return res.send(rejectPage(bookingId, sellerId));
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

// ─── Decoryy HTML Brand Templates ─────────────────────────────────────────────

const baseHtml = (content, title = "Decoryy | Instant Decoration Service") => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    .font-brand { font-family: 'Playfair Display', Georgia, serif; }
  </style>
  <script>
    function copyToClipboard(text, elemId) {
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById(elemId);
        if (btn) {
          const original = btn.innerHTML;
          btn.innerText = "Copied!";
          btn.classList.add("bg-emerald-100", "text-emerald-700");
          setTimeout(() => {
            btn.innerHTML = original;
            btn.classList.remove("bg-emerald-100", "text-emerald-700");
          }, 2000);
        }
      });
    }
  </script>
</head>
<body class="bg-[#F8F9FA] text-slate-800 flex flex-col min-h-screen">
  <header class="w-full bg-white border-b border-slate-100 py-3.5 px-6 flex items-center justify-between shadow-sm">
    <div class="flex items-center gap-2">
      <span class="text-xl font-brand font-extrabold text-slate-900 tracking-tight">Decoryy</span>
      <span class="text-[8px] font-bold tracking-widest uppercase px-2 py-0.5 bg-amber-50 text-amber-600 rounded-full border border-amber-200/60">Partner</span>
    </div>
    <span class="text-[11px] font-semibold text-slate-400">Order Dispatch</span>
  </header>

  <main class="flex-1 flex items-center justify-center p-4">
    ${content}
  </main>

  <footer class="py-4 text-center text-xs text-slate-400 border-t border-slate-100 bg-white">
    © ${new Date().getFullYear()} Decoryy Instant Decoration Service. All rights reserved.
  </footer>
</body>
</html>`;

const successPage = (booking, seller) => {
  const product = booking.selectedProductId || {};
  const productId = product._id || booking.selectedProductId;
  const productUrl = productId ? `${APP_BASE_URL}/product/${productId}` : `${APP_BASE_URL}/shop`;
  const productImage = product.image?.url || product.image || "https://upload.wikimedia.org/wikipedia/commons/e/e1/FullMoon2010.jpg";
  const venue = booking.pickupLocation?.address || "Address details on dashboard";

  const acceptUrl = `${API_BASE_URL}/accept/${booking._id}?sellerId=${seller?._id || ''}`;
  const declineUrl = `${API_BASE_URL}/reject/${booking._id}?sellerId=${seller?._id || ''}`;

  return baseHtml(`
    <div class="max-w-md w-full bg-white rounded-3xl p-6 sm:p-8 border border-slate-100 shadow-xl text-center space-y-6">
      
      <div class="w-16 h-16 bg-amber-50 text-amber-500 border border-amber-200/60 rounded-full flex items-center justify-center mx-auto text-3xl shadow-sm">
        🎉
      </div>

      <div class="space-y-1.5">
        <h1 class="text-2xl font-bold text-slate-900">Job Accepted!</h1>
        <p class="text-slate-500 text-xs sm:text-sm">This package is confirmed for you, <span class="font-semibold text-slate-800">${seller?.name || "Partner"}</span>. The customer has been notified.</p>
      </div>

      <!-- Item Card with Link -->
      <div class="p-3.5 bg-slate-50 rounded-2xl border border-slate-200/70 text-left flex gap-3.5 items-center">
        <img src="${productImage}" alt="${product.name || 'Setup'}" class="w-16 h-16 rounded-xl object-cover flex-shrink-0 border border-slate-200" />
        <div class="flex-1 min-w-0">
          <p class="text-[11px] font-bold text-amber-600 uppercase tracking-wider">Booked Package</p>
          <p class="font-bold text-sm text-slate-800 truncate">${product.name || "Decoration Package"}</p>
          <p class="text-xs font-semibold text-slate-600 mt-0.5">₹${product.price || booking.estimatedPrice || '0'}</p>
        </div>
      </div>

      <!-- Booking Specs -->
      <div class="p-4 bg-white rounded-2xl border border-slate-100 text-left space-y-2.5 text-xs">
        <div class="flex justify-between items-center py-1 border-b border-slate-50">
          <span class="text-slate-400 font-medium">Customer:</span>
          <span class="font-bold text-slate-700">${booking.serviceDetails?.name || "Client"}</span>
        </div>
        <div class="flex justify-between items-center py-1 border-b border-slate-50">
          <span class="text-slate-400 font-medium">Delivery Speed:</span>
          <span class="font-bold text-emerald-600">${product.instantDeliveryTime || "30-60 mins"}</span>
        </div>
        <div class="py-1">
          <span class="text-slate-400 font-medium block mb-1">Venue Address:</span>
          <span class="font-semibold text-slate-700 block bg-slate-50 p-2 rounded-lg leading-relaxed text-[11px]">${venue}</span>
        </div>
      </div>

      <!-- Dispatch Reference Links Section -->
      <div class="p-3.5 bg-slate-50/80 rounded-2xl border border-slate-200/60 text-left space-y-2.5">
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Order Dispatch Links</span>
        
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-slate-200/80">
            <span class="text-[11px] text-slate-500 font-medium truncate flex-1">${acceptUrl}</span>
            <button id="copyAcceptBtn" onclick="copyToClipboard('${acceptUrl}', 'copyAcceptBtn')" class="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-2 py-1 rounded transition whitespace-nowrap">
              Copy Accept Link
            </button>
          </div>

          <div class="flex items-center justify-between gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-slate-200/80">
            <span class="text-[11px] text-slate-500 font-medium truncate flex-1">${declineUrl}</span>
            <button id="copyDeclineBtn" onclick="copyToClipboard('${declineUrl}', 'copyDeclineBtn')" class="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-2 py-1 rounded transition whitespace-nowrap">
              Copy Decline Link
            </button>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="space-y-2.5 pt-2">
        <a href="${productUrl}" target="_blank" class="w-full inline-flex items-center justify-center gap-2 bg-[#FFB000] hover:bg-[#e09b00] text-white font-bold py-3.5 px-4 rounded-xl transition-all shadow-md shadow-amber-500/20 text-sm">
          <span>View Product Page</span>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
        </a>
        <button onclick="window.close()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-600 font-semibold py-3 px-4 rounded-xl transition text-xs">
          Close Window
        </button>
      </div>

    </div>
  `);
};

const rejectPage = (bookingId, sellerId) => {
  const acceptUrl = bookingId && sellerId ? `${API_BASE_URL}/accept/${bookingId}?sellerId=${sellerId}` : '';
  const declineUrl = bookingId && sellerId ? `${API_BASE_URL}/reject/${bookingId}?sellerId=${sellerId}` : '';

  return baseHtml(`
  <div class="max-w-md w-full bg-white rounded-3xl p-6 sm:p-8 border border-slate-100 shadow-xl text-center space-y-6">
    <div class="w-16 h-16 bg-slate-100 text-slate-500 rounded-full flex items-center justify-center mx-auto text-2xl">
      ↩️
    </div>
    <div class="space-y-1.5">
      <h1 class="text-xl font-bold text-slate-900">Offer Declined</h1>
      <p class="text-slate-500 text-xs sm:text-sm">No worries! We have released this task to the next available decorator.</p>
    </div>

    ${bookingId && sellerId ? `
      <!-- Dispatch Reference Links Section -->
      <div class="p-3.5 bg-slate-50/80 rounded-2xl border border-slate-200/60 text-left space-y-2.5">
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Order Dispatch Links</span>
        
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-slate-200/80">
            <span class="text-[11px] text-slate-500 font-medium truncate flex-1">${acceptUrl}</span>
            <button id="copyAcceptBtn" onclick="copyToClipboard('${acceptUrl}', 'copyAcceptBtn')" class="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-2 py-1 rounded transition whitespace-nowrap">
              Copy Accept Link
            </button>
          </div>

          <div class="flex items-center justify-between gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-slate-200/80">
            <span class="text-[11px] text-slate-500 font-medium truncate flex-1">${declineUrl}</span>
            <button id="copyDeclineBtn" onclick="copyToClipboard('${declineUrl}', 'copyDeclineBtn')" class="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-2 py-1 rounded transition whitespace-nowrap">
              Copy Decline Link
            </button>
          </div>
        </div>
      </div>
    ` : ''}

    <button onclick="window.close()" class="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3.5 px-4 rounded-xl transition text-xs shadow-md">
      Close Window
    </button>
  </div>
`);
};

const warningPage = (message) => baseHtml(`
  <div class="max-w-md w-full bg-white rounded-3xl p-6 sm:p-8 border border-slate-100 shadow-xl text-center space-y-6">
    <div class="w-16 h-16 bg-amber-50 text-amber-500 border border-amber-200/60 rounded-full flex items-center justify-center mx-auto text-2xl">
      ⏳
    </div>
    <div class="space-y-1.5">
      <h1 class="text-xl font-bold text-slate-900">Request Unavailable</h1>
      <p class="text-slate-500 text-xs sm:text-sm leading-relaxed">${message}</p>
    </div>
    <button onclick="window.close()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3 px-4 rounded-xl transition text-xs">
      Close Window
    </button>
  </div>
`);

const errorPage = (message) => baseHtml(`
  <div class="max-w-md w-full bg-white rounded-3xl p-6 sm:p-8 border border-slate-100 shadow-xl text-center space-y-5">
    <div class="w-14 h-14 bg-rose-50 text-rose-500 border border-rose-200/60 rounded-full flex items-center justify-center mx-auto text-2xl">
      ⚠️
    </div>
    <div class="space-y-1">
      <h1 class="text-lg font-bold text-slate-900">Something went wrong</h1>
      <p class="text-slate-500 text-xs leading-relaxed">${message}</p>
    </div>
    <button onclick="window.close()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3 px-4 rounded-xl transition text-xs">
      Close
    </button>
  </div>
`);