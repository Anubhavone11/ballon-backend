const express = require('express');
const router = express.Router();
const { createInstantBooking, createScheduledBooking, processMatchmakingPipeline } = require('../controllers/bookingController');
const { notifyCustomerOfAssignment } = require('../services/notificationService');
const { Booking, Vendor } = require('../models/vendor');

// Mock Authentication Guard to resolve req.user parameters safely
const dummyAuthGuard = (req, res, next) => {
    req.user = { id: "650c5eb9f0123456789abcde" }; // Replace with custom JWT verification layer logic
    next();
};

router.post('/instant-decor', dummyAuthGuard, createInstantBooking);
// router.post('/scheduled-decor', dummyAuthGuard, createScheduledBooking);

// VENDOR RESPONSE ACTION: ACCEPT
router.post('/booking/accept', async (req, res) => {
    const { bookingId, vendorId } = req.body;
    try {
        // Enforce strict state check via atomic findOneAndUpdate check
        const assignedBooking = await Booking.findOneAndUpdate(
            { _id: bookingId, status: 'pending_allocation' },
            { vendorId: vendorId, status: 'vendor_assigned' },
            { new: true }
        ).populate('vendorId');

        if (!assignedBooking) {
            return res.status(400).json({ success: false, message: "Offer expired or claimed by another team." });
        }

        await Vendor.findByIdAndUpdate(vendorId, { isAllocated: true });
        await notifyCustomerOfAssignment(assignedBooking.userId, assignedBooking);

        return res.status(200).json({ success: true, booking: assignedBooking });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Transaction database update error." });
    }
});

// VENDOR RESPONSE ACTION: DECLINE
router.post('/booking/decline', async (req, res) => {
    const { bookingId, vendorId } = req.body;
    try {
        const booking = await Booking.findById(bookingId);
        const currentVendorId = booking.routingQueue[booking.currentRoutingIndex];

        if (booking && booking.status === 'pending_allocation' && currentVendorId.toString() === vendorId) {
            booking.currentRoutingIndex += 1;
            await booking.save();

            // Advance the pipeline immediately without waiting out the 30-second timeout window
            processMatchmakingPipeline(bookingId);
            return res.status(200).json({ success: true, message: "Declined. Dispatched to next vendor pool." });
        }
        return res.status(400).json({ success: false, message: "Invalid route processing parameters." });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Server error handling vendor decline." });
    }
});

module.exports = router;