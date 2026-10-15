// backend/routes/notifications.js
const express = require('express');
const mongoose = require('mongoose');
const { Expo } = require('expo-server-sdk');

const userAuth = require('../middleware/userAuth');     // customers
const sellerAuth = require('../middleware/sellerAuth'); // partners
const Notification = require('../models/Notification'); // <-- REQUIRED FOR IN-APP NOTIFICATIONS

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

// One endpoint for everyone: works with a customer login OR a partner login
async function eitherAuth(req, res, next) {
  if (await tryAuth(userAuth, req)) {
    req.accountType = 'customer';
    return next();
  }
  if (await tryAuth(sellerAuth, req)) {
    req.accountType = 'seller';
    return next();
  }
  return res.status(401).json({ success: false, message: 'Not authorized' });
}

// Finds the signed-in account's model + id
function resolveAccount(req) {
  if (req.accountType === 'seller') {
    const id = req.seller?._id || req.seller?.id || req.sellerId || req.user?._id || req.user?.id;
    return { Model: mongoose.models.Seller, id };
  }
  const id = req.user?._id || req.user?.id || req.userId;
  return { Model: mongoose.models.User, id };
}

// ---------------------------------------------------------------------------
// 1. GET /api/notifications?ownerId=...&ownerType=...  <-- THIS STOPS THE 404
// ---------------------------------------------------------------------------
// In backend/routes/notifications.js
router.get('/', async (req, res) => {
  try {
    const { ownerId, ownerType = 'customer' } = req.query;

    if (!ownerId) {
      return res.status(400).json({ success: false, message: 'ownerId is required' });
    }

    // Convert string to ObjectId if valid
    const targetId = mongoose.Types.ObjectId.isValid(ownerId)
      ? new mongoose.Types.ObjectId(ownerId)
      : ownerId;

    const notifications = await Notification.find({
      $or: [{ ownerId: targetId }, { ownerId: String(ownerId) }],
      ownerType,
    })
      .sort({ createdAt: -1 })
      .limit(20);

    return res.status(200).json({
      success: true,
      notifications,
    });
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
// 3. POST /api/notifications/register-token
// ---------------------------------------------------------------------------
router.post('/register-token', eitherAuth, async (req, res) => {
  const { token } = req.body;
  if (!Expo.isExpoPushToken(token)) {
    return res.status(400).json({ success: false, message: 'Invalid push token' });
  }

  const { Model, id } = resolveAccount(req);
  if (!Model || !id) {
    console.error(
      '[PUSH] Could not find the account. Model missing or id not set by middleware. type =',
      req.accountType
    );
    return res.status(500).json({ success: false, message: 'Account lookup failed' });
  }

  await Model.updateOne({ _id: id }, { $addToSet: { pushTokens: token } });
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// 4. POST /api/notifications/unregister-token
// ---------------------------------------------------------------------------
router.post('/unregister-token', eitherAuth, async (req, res) => {
  const { Model, id } = resolveAccount(req);
  if (!Model || !id) return res.status(500).json({ success: false });

  await Model.updateOne({ _id: id }, { $pull: { pushTokens: req.body.token } });
  return res.json({ success: true });
});

module.exports = router;