// routes/activityRoutes.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { auth } = require('../middleware/auth'); // Admin check middleware
const {
  trackCheckoutStarted,
  trackCheckoutCompleted,
  getLoginStatus,
  getNeverLoggedIn,
  getInactiveUsers,
  getUserActivity,
  getAllActivity,
  getMostViewedProducts,
  getUserProductHistory,
  getCheckoutFunnel,
} = require('../controllers/activityController');

// Optional customer authenticator: Reads the Bearer token if present
// without rejecting requests or checking for admin properties
const optionalCustomerAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_fallback_secret');
      req.user = decoded; // Sets { id: '6a3ec17...', phone: '...' }
    } catch {
      req.user = null;
    }
  }
  next();
};

// ============================================================================
// 1. EVENT INGESTION (Accessible by users & guests - No admin middleware)
// ============================================================================
router.post('/checkout-started', optionalCustomerAuth, trackCheckoutStarted);
router.post('/checkout-completed', optionalCustomerAuth, trackCheckoutCompleted);

// ============================================================================
// 2. ADMIN-ONLY REPORTS (Protected by auth middleware)
// ============================================================================
router.use(auth);

router.get('/status', getLoginStatus);                       // who's logged in / logged out right now
router.get('/never-logged-in', getNeverLoggedIn);             // who has zero login events
router.get('/inactive', getInactiveUsers);                    // ?days=30 -> stale logins
router.get('/feed', getAllActivity);                          // global audit feed, paginated
router.get('/user/:userId', getUserActivity);                 // one user's history, paginated

router.get('/products/most-viewed', getMostViewedProducts);   // ?limit=20
router.get('/user/:userId/products', getUserProductHistory);   // what THIS user browsed
router.get('/checkout-funnel', getCheckoutFunnel);            // ?days=30 view->checkout->order

module.exports = router;