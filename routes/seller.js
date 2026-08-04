const express = require('express');
const router = express.Router();
const sellerAuthController = require('../controllers/sellerAuthController');
const { handleProfileImage } = require('../middleware/sellerUpload');
const sellerAuth = require('../middleware/sellerAuth');
const { auth } = require('../middleware/auth');

// Test route
router.get('/test', sellerAuthController.test);

// Public: OTP-based registration & login (no password)
router.post('/send-otp', handleProfileImage, sellerAuthController.sendOtp);
router.post('/verify-otp', sellerAuthController.verifyOtp);
router.post('/login/send-otp', sellerAuthController.sendLoginOtp);
router.post('/login/verify-otp', sellerAuthController.verifyOtp);

// Real-Time On-Demand Operations
router.get('/bookings', sellerAuth, sellerAuthController.getSellerAssignedBookings);
router.patch('/toggle-allocation', sellerAuth, sellerAuthController.toggleAllocationStatus);

// Profile paths (using JWT verification)
router.get('/profile', sellerAuth, sellerAuthController.getProfile);
router.put('/profile', sellerAuth, sellerAuthController.updateProfile);
router.post('/upload-passport-photo', sellerAuth, handleProfileImage, sellerAuthController.uploadPassportPhoto);

// Administrative Controls (Protected)
router.get('/all', auth, sellerAuthController.getAllSellers);
router.delete('/:id', auth, sellerAuthController.deleteSeller);
router.get('/:id', sellerAuthController.getSellerById);

// ⚡ Administrative Toggle Actions (Verify, Suspend, Premium Tier Upgrade)
router.patch('/:id/approve', auth, sellerAuthController.setApprovalStatus);
router.patch('/:id/block', auth, sellerAuthController.setBlockedStatus);
router.patch('/:id/premium', auth, sellerAuthController.updateSellerPremiumStatus);
router.patch('/:id/add-payment', auth, sellerAuthController.addManualPayment);

module.exports = router;