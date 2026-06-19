const express = require('express');
const router = express.Router();
const adminBookingController = require('../controllers/adminBookingController');
const { auth } = require('../middleware/auth'); // Global system admin authorization token validator

router.get('/all', auth, adminBookingController.getAllBookingsAdmin);
router.get('/matchmaker/:bookingId', auth, adminBookingController.getEligibleVendorsForJob);
router.patch('/assign/:bookingId', auth, adminBookingController.assignVendorToBooking);
router.patch(
  '/:sellerId/:actionType', 
  auth, 
  adminBookingController.updateSellerStatusAdmin
);
module.exports = router;