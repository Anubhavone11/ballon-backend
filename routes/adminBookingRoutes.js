const express = require('express');
const router = express.Router();
const Booking = require("../models/Booking");
const adminBookingController = require('../controllers/adminBookingController');
const { auth } = require('../middleware/auth');

const VALID_STATUSES = [
  "pending_allocation",
  "seller_assigned",
  "accepted",
  "rejected",
  "completed",
  "cancelled",
  "allocation_failed"
];

router.get('/all', auth, adminBookingController.getAllBookingsAdmin);
router.get('/matchmaker/:bookingId', auth, adminBookingController.getEligibleVendorsForJob);
router.patch('/assign/:bookingId', auth, adminBookingController.assignVendorToBooking);

// 🔧 Moved ABOVE '/:sellerId/:actionType' so it isn't shadowed
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status: ${status}` });
    }
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    res.json({ success: true, booking });
  } catch (err) {
    console.error("Update booking status error:", err);
    res.status(500).json({ success: false, message: "Failed to update booking status" });
  }
});

router.patch(
  '/:sellerId/:actionType',
  auth,
  adminBookingController.updateSellerStatusAdmin
);

module.exports = router;