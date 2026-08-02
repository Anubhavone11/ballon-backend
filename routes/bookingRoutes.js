const express = require("express");
const router = express.Router();

const bookingController = require("../controllers/bookingController");

// Import specific authentication middlewares
const userAuth = require("../middleware/userAuth");      // For regular customers/buyers
const { auth } = require("../middleware/auth");
const sellerAuth = require("../middleware/sellerAuth");  // For venue owners/partners

// ─── IMPORTANT: Express matches routes top-to-bottom, first match wins. ───────
// Every literal/specific path (e.g. "/accept/:bookingId", "/user/history")
// MUST be declared BEFORE the generic "/:bookingId" wildcard route further
// down, or the wildcard will swallow it (e.g. GET /accept/123 would match
// "/:bookingId" with bookingId="accept" instead of hitting acceptBooking).

// --- CUSTOMER BOOKING ENDPOINTS (Protected by userAuth) ---
router.post(
  "/instant",
  userAuth,
  bookingController.createInstantBooking
);

router.post(
  "/scheduled",
  userAuth,
  bookingController.createScheduledBooking
);

router.get(
  "/user/history",
  userAuth,
  bookingController.getUserBookings
);

router.get("/seller/history", sellerAuth, bookingController.getSellerAssignedBookings);

router.patch(
  "/cancel/:bookingId",
  userAuth,
  bookingController.cancelBooking
);

// --- SELLER PARTNER ENDPOINTS ---

// FIX 1: .get instead of .patch so clicking the link from WhatsApp works instantly.
// FIX 2: No auth middleware — external browser links can't carry JWT headers.
//        The controller safely uses the ?sellerId= query param for validation.
router.get(
  "/accept/:bookingId",
  bookingController.acceptBooking
);

router.get(
  "/reject/:bookingId",
  bookingController.rejectBooking
);

router.patch(
  "/seller-cancel/:bookingId",
  sellerAuth, // Replaces generic auth so seller_jwt works perfectly
  bookingController.sellerCancelBooking
);

// Kept as PATCH/auth — hit natively inside your authenticated Partner App dashboard
router.patch(
  "/complete/:bookingId",
  sellerAuth,
  bookingController.completeBooking
);

// ─── Seller sends GPS pings (from their vendor-track page) ───────────────────

router.post("/:bookingId/vendor-location", bookingController.updateVendorLocation);
router.get("/:bookingId/vendor-location", bookingController.getVendorLocation); // internal use

// ─── Public customer tracking (matches the WhatsApp template button URL) ─────
// Template button URL = https://decoryy.com/track/<token>
// Frontend page at /track/:token calls this to get the live location.

router.get("/track/:token", bookingController.getVendorLocationByToken);

// ─── Generic wildcard — MUST stay LAST among the GET "/something" routes. ────
// Lets the customer frontend poll booking/offer status by raw ID.
router.get(
  "/:bookingId",
  userAuth,
  bookingController.getBookingStatus
);

module.exports = router;