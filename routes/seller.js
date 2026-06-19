const express = require('express');
const router = express.Router();
const sellerAuthController = require('../controllers/sellerAuthController');
const { handleMultipleImages, handleProfileImage } = require('../middleware/sellerUpload');
const sellerAuth = require('../middleware/sellerAuth');
const { auth } = require('../middleware/auth');

// Test route
router.get('/test', sellerAuthController.test);

// Debug route to list all sellers
router.get('/list-all', sellerAuthController.listAllSellers);

// Public routes
router.post('/register', handleMultipleImages, sellerAuthController.register);
router.post('/login', sellerAuthController.login);

// Admin route to get all sellers
router.get('/all', auth, sellerAuthController.getAllSellers);

// Public route to get approved venues (no authentication required)
router.get('/venues', sellerAuthController.getApprovedVenues);

// Public route to increment seller views (no authentication required)
router.post('/:id/view', sellerAuthController.incrementViews);
router.get('/bookings', sellerAuth, sellerAuthController.getSellerAssignedBookings);
// Toggle availability (isAllocated status)
router.patch('/toggle-allocation', sellerAuth, sellerAuthController.toggleAllocationStatus);
// Profile routes (using JWT authentication)
router.get('/profile', sellerAuth, sellerAuthController.getProfile);
router.put('/profile', sellerAuth, sellerAuthController.updateProfile);
router.post('/upload-images', handleMultipleImages, sellerAuthController.uploadImages);
router.post('/upload-profile-image', handleProfileImage, sellerAuthController.uploadProfileImage);
router.delete('/delete-image/:imageId', sellerAuthController.deleteImage);

// Utility route to update unique fields
router.put('/update-unique-fields', sellerAuthController.updateUniqueFields);

// Delete seller (admin only)
router.delete('/:id', auth, sellerAuthController.deleteSeller);

// Delete image (admin only)
router.delete('/:sellerId/image/:imageId', auth, sellerAuthController.deleteImageAdmin);

// Delete profile image (admin only)
router.delete('/:sellerId/profile-image', auth, sellerAuthController.deleteProfileImageAdmin);

// Block/unblock seller (admin only)
router.patch('/:id/block', auth, sellerAuthController.setBlockedStatus);
router.get('/:id', sellerAuthController.getSellerById);
// Approve/disapprove seller (admin only)
router.patch('/:id/approve', auth, sellerAuthController.setApprovalStatus);
// Update seller profile (admin only)
router.put('/:id/profile', auth, sellerAuthController.updateSellerProfile);

// Update seller (admin only) - general update endpoint
router.put('/:id', auth, handleMultipleImages, sellerAuthController.updateSellerProfile);

module.exports = router; 