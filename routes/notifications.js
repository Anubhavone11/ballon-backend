const express = require('express');
const mongoose = require('mongoose');
const { Expo } = require('expo-server-sdk');

const userAuth = require('../middleware/userAuth');     // customers
const sellerAuth = require('../middleware/sellerAuth'); // partners
const Notification = require('../models/Notification');
const { publicKey, sendWebPush } = require('../notifications/webPush');
const { log, entries } = require('../utils/pushLog');

const router = express.Router();

/**
 * Runs an existing middleware without letting it answer the request.
 * Resolves true if it called next() with no error, false if it rejected the login.
 */
function tryAuth(mw, req) {
  return new Promise((resolve) => {
    const fakeRes = {
      status() { return this; },
      json() { resolve(false); return this; },
      send() { resolve(false); return this; },
      sendStatus() { resolve(false); return this; },
      end() { resolve(false); return this; },
      setHeader() { return this; },
      set() { return this; },
      cookie() { return this; },
    };
    try {
      const out = mw(req, fakeRes, (err) => resolve(!err));
      if (out && typeof out.catch === 'function') out.catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function eitherAuth(req, res, next) {
  if (await tryAuth(userAuth, req)) {
    req.accountType = 'customer';
    return next();
  }
  if (await tryAuth(sellerAuth, req)) {
    req.accountType = 'seller';
    return next();
  }
  log('auth:REJECTED', { path: req.path, hasAuthHeader: !!req.headers.authorization }, 'error');
  return res.status(401).json({ success: false, message: 'Not authorized' });
}

function resolveAccount(req) {
  if (req.accountType === 'seller') {
    const id = req.seller?._id || req.seller?.id || req.sellerId || req.user?._id || req.user?.id;
    return { Model: mongoose.models.Seller, id };
  }
  const id = req.user?._id || req.user?.id || req.userId;
  return { Model: mongoose.models.User, id };
}

// ---------------------------------------------------------------------------
// 1. GET /api/notifications?ownerId=...&ownerType=...
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { ownerId, ownerType = 'customer' } = req.query;
    if (!ownerId) {
      return res.status(400).json({ success: false, message: 'ownerId is required' });
    }

    const targetId = mongoose.Types.ObjectId.isValid(ownerId)
      ? new mongoose.Types.ObjectId(ownerId)
      : ownerId;

    const notifications = await Notification.find({
      $or: [{ ownerId: targetId }, { ownerId: String(ownerId) }],
      ownerType,
    })
      .sort({ createdAt: -1 })
      .limit(20);

    return res.status(200).json({ success: true, notifications });
  } catch (err) {
    console.error('[NOTIFICATIONS GET ERROR]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. PATCH /api/notifications/:id/read
// ---------------------------------------------------------------------------
router.patch('/:id/read', async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { read: true });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 3. Expo (mobile app) tokens
// ---------------------------------------------------------------------------
router.post('/register-token', eitherAuth, async (req, res) => {
  const { token } = req.body;
  if (!Expo.isExpoPushToken(token)) {
    return res.status(400).json({ success: false, message: 'Invalid push token' });
  }

  const { Model, id } = resolveAccount(req);
  if (!Model || !id) {
    log('expo-register:account-NOT-FOUND', { type: req.accountType }, 'error');
    return res.status(500).json({ success: false, message: 'Account lookup failed' });
  }

  await Model.updateOne({ _id: id }, { $addToSet: { pushTokens: token } });
  return res.json({ success: true });
});

router.post('/unregister-token', eitherAuth, async (req, res) => {
  const { Model, id } = resolveAccount(req);
  if (!Model || !id) return res.status(500).json({ success: false });

  await Model.updateOne({ _id: id }, { $pull: { pushTokens: req.body.token } });
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// 4. Web push (browser)
// ---------------------------------------------------------------------------
router.get('/web-push/public-key', (req, res) => {
  if (!publicKey) {
    log('public-key:VAPID-MISSING', {}, 'error');
    return res.status(503).json({ success: false, message: 'Web push not configured' });
  }
  return res.json({ success: true, publicKey });
});

router.post('/web-push/subscribe', eitherAuth, async (req, res) => {
  try {
    const sub = req.body.subscription;
    log('subscribe:received', {
      accountType: req.accountType,
      hasEndpoint: !!sub?.endpoint,
      hasKeys: !!(sub?.keys?.p256dh && sub?.keys?.auth),
    });

    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ success: false, message: 'Invalid subscription' });
    }

    const { Model, id } = resolveAccount(req);
    log('subscribe:account', { model: Model?.modelName, id: String(id || '') });
    if (!Model || !id) {
      log('subscribe:account-NOT-FOUND', { accountType: req.accountType }, 'error');
      return res.status(500).json({ success: false, message: 'Account lookup failed' });
    }

    // A browser belongs to one account at a time
    await Promise.all(
      [mongoose.models.User, mongoose.models.Seller].filter(Boolean).map((M) =>
        M.updateMany(
          { 'webPushSubscriptions.endpoint': sub.endpoint },
          { $pull: { webPushSubscriptions: { endpoint: sub.endpoint } } }
        )
      )
    );

    const r = await Model.updateOne(
      { _id: id },
      { $push: { webPushSubscriptions: { endpoint: sub.endpoint, keys: sub.keys } } }
    );
    // matched=0 -> wrong id/model. matched=1 but modified=0 -> schema field missing
    log('subscribe:saved', { matched: r.matchedCount, modified: r.modifiedCount },
      r.modifiedCount ? 'info' : 'error');

    return res.json({ success: true, matched: r.matchedCount, modified: r.modifiedCount });
  } catch (err) {
    log('subscribe:ERROR', { msg: err.message }, 'error');
    return res.status(500).json({ success: false });
  }
});

router.post('/web-push/unsubscribe', eitherAuth, async (req, res) => {
  try {
    const { Model, id } = resolveAccount(req);
    if (!Model || !id) return res.status(500).json({ success: false });

    await Model.updateOne(
      { _id: id },
      { $pull: { webPushSubscriptions: { endpoint: req.body.endpoint } } }
    );
    log('unsubscribe:done', { id: String(id) });
    return res.json({ success: true });
  } catch (err) {
    log('unsubscribe:ERROR', { msg: err.message }, 'error');
    return res.status(500).json({ success: false });
  }
});

// Sends a test notification to the logged-in account
router.post('/web-push/test', eitherAuth, async (req, res) => {
  const { Model, id } = resolveAccount(req);
  if (!Model || !id) return res.status(500).json({ success: false });
  const doc = await Model.findById(id).select('webPushSubscriptions').lean();
  await sendWebPush(Model, id, { title: 'Test', body: 'It works 🎉', url: '/' });
  res.json({ success: true, subs: doc?.webPushSubscriptions?.length || 0 });
});

// ---------------------------------------------------------------------------
// 5. Debug tools
// View logs: GET /api/notifications/web-push/debug?key=YOUR_DEBUG_KEY
// ---------------------------------------------------------------------------
router.get('/web-push/debug', async (req, res) => {
  if (!process.env.DEBUG_KEY || req.query.key !== process.env.DEBUG_KEY) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  const User = mongoose.models.User;
  const Seller = mongoose.models.Seller;
  const withSubs = { 'webPushSubscriptions.0': { $exists: true } };

  res.json({
    vapidConfigured: !!publicKey,
    usersWithWebPush: User ? await User.countDocuments(withSubs) : null,
    sellersWithWebPush: Seller ? await Seller.countDocuments(withSubs) : null,
    logs: entries.slice(-150).reverse(), // newest first
  });
});

// The browser sends its own steps here so everything is in one log
router.post('/web-push/client-log', (req, res) => {
  if (process.env.DEBUG_PUSH !== '1') return res.json({ success: true });
  const { step, data } = req.body || {};
  log('client:' + String(step).slice(0, 60), { data: JSON.stringify(data || {}).slice(0, 500) });
  res.json({ success: true });
});
// Send a test push to a user by id (opens from the browser address bar)
// GET /api/notifications/web-push/debug-send?key=DEBUG_KEY&id=USER_ID&type=customer
// GET /api/notifications/web-push/debug-send?key=DEBUG_KEY&id=USER_ID&type=customer
router.get('/web-push/debug-send', async (req, res) => {
  if (!process.env.DEBUG_KEY || req.query.key !== process.env.DEBUG_KEY) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  const Model = req.query.type === 'seller' ? mongoose.models.Seller : mongoose.models.User;
  console.log('USER SCHEMA PATHS:', Object.keys(mongoose.models.User.schema.paths).join(', '));
  console.log('SCHEMA HAS FIELD:', !!Model.schema.path('webPushSubscriptions'), 'collection:', Model.collection.name);
  const doc = await Model.findById(req.query.id).select('webPushSubscriptions').lean();
  const subs = doc?.webPushSubscriptions || [];
  await sendWebPush(Model, req.query.id, { title: 'Test', body: 'Server push works 🎉', url: '/' });
  res.json({
    subsStored: subs.length,
    hosts: subs.map((s) => { try { return new URL(s.endpoint).host; } catch { return '?'; } }),
    note: 'Check the debug viewer for send:ok or send:FAILED',
  });
});
module.exports = router;