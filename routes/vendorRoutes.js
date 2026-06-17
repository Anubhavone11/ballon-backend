const express = require('express');
const router = express.Router();
const { vendorSignup, vendorLogin, toggleStatus } = require('../controllers/vendorAuthController');
const { verifyVendorToken } = require('../middleware/auth');

// Public Partner Endpoints
router.post('/vendor/signup', vendorSignup);
router.post('/vendor/login', vendorLogin);

// Protected Partner System Control Endpoints
router.patch('/vendor/toggle-presence', verifyVendorToken, toggleStatus);

module.exports = router;