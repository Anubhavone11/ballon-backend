// controllers/activityController.js
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');

// ============================================================================
// 1. EVENT INGESTION (Customer Client Events)
// ============================================================================

// POST /api/activity-tracking/checkout-started
async function trackCheckoutStarted(req, res) {
  try {
    const userId = req.user?.id || req.user?._id || null;
    const { productId, quantity } = req.body;

    await ActivityLog.create({
      user: userId,
      action: 'checkout_started',
      product: productId || null,
      metadata: { quantity: Number(quantity) || 1 }
    });

    return res.status(200).json({ success: true, message: 'Checkout start recorded' });
  } catch (err) {
    console.error('Error logging checkout_started:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// POST /api/activity-tracking/checkout-completed
async function trackCheckoutCompleted(req, res) {
  try {
    const userId = req.user?.id || req.user?._id || null;
    const { orderId, paymentMethod, amount } = req.body;

    await ActivityLog.create({
      user: userId,
      action: 'checkout_completed',
      metadata: { orderId, paymentMethod, amount }
    });

    return res.status(200).json({ success: true, message: 'Checkout completion recorded' });
  } catch (err) {
    console.error('Error logging checkout_completed:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ============================================================================
// 2. READ-ONLY ADMIN REPORTS
// ============================================================================

// GET /api/activity/status
async function getLoginStatus(req, res) {
  try {
    const latestPerUser = await ActivityLog.aggregate([
      { $sort: { user: 1, createdAt: -1 } },
      { $group: { _id: '$user', lastAction: { $first: '$action' }, lastAt: { $first: '$createdAt' } } },
    ]);

    const statusMap = new Map(latestPerUser.map((d) => [String(d._id), d]));
    const users = await User.find({}, 'name phone email').lean();

    const result = users.map((u) => {
      const s = statusMap.get(String(u._id));
      return {
        id: u._id,
        name: u.name,
        phone: u.phone,
        email: u.email || null,
        status: s ? (s.lastAction === 'login' ? 'logged_in' : 'logged_out') : 'no_login_recorded',
        lastActivityAt: s ? s.lastAt : null,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/activity/never-logged-in
async function getNeverLoggedIn(req, res) {
  try {
    const activeUserIds = await ActivityLog.distinct('user', { action: 'login' });
    const users = await User.find({ _id: { $nin: activeUserIds } }, 'name phone email createdAt');
    res.json({
      note: 'Users with no login recorded since activity tracking began (likely pre-existing accounts).',
      count: users.length,
      users,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/activity/inactive?days=30
async function getInactiveUsers(req, res) {
  const days = parseInt(req.query.days, 10) || 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const latestLogins = await ActivityLog.aggregate([
      { $match: { action: 'login' } },
      { $sort: { user: 1, createdAt: -1 } },
      { $group: { _id: '$user', lastLoginAt: { $first: '$createdAt' } } },
      { $match: { lastLoginAt: { $lt: cutoff } } },
    ]);

    const ids = latestLogins.map((d) => d._id);
    const users = await User.find({ _id: { $in: ids } }, 'name phone email');
    const lastLoginById = new Map(latestLogins.map((d) => [String(d._id), d.lastLoginAt]));

    const merged = users
      .map((u) => ({
        id: u._id,
        name: u.name,
        phone: u.phone,
        email: u.email,
        lastLoginAt: lastLoginById.get(String(u._id)),
      }))
      .sort((a, b) => a.lastLoginAt - b.lastLoginAt);

    res.json({ cutoffDays: days, count: merged.length, users: merged });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/activity/user/:userId
async function getUserActivity(req, res) {
  const { userId } = req.params;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;

  try {
    const logs = await ActivityLog.find({ user: userId })
      .populate('product', 'name price images slug') // 👈 Ensure product fields are populated
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ page, limit, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/activity/feed
async function getAllActivity(req, res) {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;

  try {
   const logs = await ActivityLog.find({})
      .populate('user', 'name phone email')
      .populate('product', 'name price images slug') // 👈 Ensure product fields are populated
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ page, limit, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/activity/products/most-viewed?limit=20
// GET /api/activity-tracking/products/most-viewed?limit=20
async function getMostViewedProducts(req, res) {
  const limit = parseInt(req.query.limit, 10) || 10;

  try {
    const results = await ActivityLog.aggregate([
      { $match: { action: 'product_view', product: { $ne: null } } },
      { $group: { _id: '$product', views: { $sum: 1 }, lastViewedAt: { $max: '$createdAt' } } },
      { $sort: { views: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'products', // your MongoDB collection name for products
          localField: '_id',
          foreignField: '_id',
          as: 'productDetails'
        }
      },
      { $unwind: { path: '$productDetails', preserveNullAndEmptyArrays: true } }
    ]);

    const formatted = results.map((r) => ({
      productId: r._id,
      views: r.views,
      lastViewedAt: r.lastViewedAt,
      name: r.productDetails?.name || 'Product ' + String(r._id).substring(0, 8),
      price: r.productDetails?.price || null,
      image: r.productDetails?.images?.[0] || null
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/activity/user/:userId/products
async function getUserProductHistory(req, res) {
  const { userId } = req.params;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;

  try {
    const logs = await ActivityLog.find({ user: userId, action: 'product_view' })
      .populate('product')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ page, limit, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/activity/checkout-funnel
async function getCheckoutFunnel(req, res) {
  const days = parseInt(req.query.days, 10) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const [viewed, started, completed] = await Promise.all([
      ActivityLog.distinct('user', { action: 'product_view', createdAt: { $gte: since } }),
      ActivityLog.distinct('user', { action: 'checkout_started', createdAt: { $gte: since } }),
      ActivityLog.distinct('user', { action: 'checkout_completed', createdAt: { $gte: since } }),
    ]);

    res.json({
      windowDays: days,
      viewedProduct: viewed.length,
      startedCheckout: started.length,
      completedCheckout: completed.length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
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
};