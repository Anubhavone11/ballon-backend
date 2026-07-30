const express = require("express");
const router = express.Router();
const Booking = require("../models/Booking");
const bookingController = require("../controllers/bookingController");

// Import specific authentication middlewares
const userAuth = require("../middleware/userAuth");      // For regular customers/buyers
const { auth } = require("../middleware/auth");
const sellerAuth = require("../middleware/sellerAuth");  // For venue owners/partners

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

// Lets the customer frontend poll booking/offer status
router.get(
  "/:bookingId",
  userAuth,
  bookingController.getBookingStatus
);
router.get("/seller/history", sellerAuth, bookingController.getSellerAssignedBookings);
router.patch(
  "/cancel/:bookingId",
  userAuth,
  bookingController.cancelBooking
);

// --- SELLER PARTNER ENDPOINTS ---

// 🛠️ FIX 1: Changed from .patch to .get so clicking the link from WhatsApp works instantly.
// 🛠️ FIX 2: Removed the auth middleware because external browser links cannot carry JWT headers. 
//           The controller now safely uses the query parameter (?phone=...) for validation.
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
  sellerAuth, //  Replaces generic auth so seller_jwt works perfectly
  bookingController.sellerCancelBooking
);
// Keep this as PATCH/auth because this is hit natively inside your authenticated Partner App dashboard framework
router.patch(
  "/complete/:bookingId",
  sellerAuth,
  bookingController.completeBooking
);
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const booking = await Booking.findByIdAndUpdate(req.params.id, { status }, { new: true });
  res.json({ success: true, booking });
});
module.exports = router;