'use strict';
const express = require('express');
const userAuth = require('../middleware/userAuth'); // your existing customer auth
const attachUserId = require('../middleware/attachUserId');
const p = require('../controllers/personalizationcontroller');

const router = express.Router();

// Public: content-based, uses no personal data.
router.get('/similar/:productId', p.getSimilar);

// Everything below needs a logged-in customer.
router.use(userAuth, attachUserId);
router.post('/views/:productId', p.trackView);
router.get('/recently-viewed', p.getRecentlyViewed);
router.delete('/recently-viewed', p.clearRecentlyViewed);
router.get('/recommendations', p.getRecommendations);

module.exports = router;