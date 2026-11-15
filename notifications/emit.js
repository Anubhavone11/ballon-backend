const mongoose = require('mongoose');
const { Expo } = require('expo-server-sdk');
const Notification = require('../models/Notification');
const { sendWebPush, webUrlFor } = require('./webPush');
const { log } = require('../utils/pushLog');
const events = require('./events');

const expo = new Expo();

async function sendExpo(Model, id, m) {
  const doc = await Model.findById(id).select('pushTokens').lean();
  const tokens = (doc?.pushTokens || []).filter((t) => Expo.isExpoPushToken(t));
  log('expo:tokens-found', { id: String(id), count: tokens.length });
  if (!tokens.length) return;

  const messages = tokens.map((to) => ({
    to,
    title: m.title,
    body: m.body,
    sound: m.sound || 'default',
    priority: m.priority || 'high',
    channelId: m.channelId || 'default',
    ...(m.categoryId ? { categoryId: m.categoryId } : {}),
    data: { route: m.route, ...(m.data || {}) },
  }));

  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      const bad = [];
      tickets.forEach((t, i) => {
        if (t.status === 'error') {
          log('expo:ticket-error', { error: t.details?.error, message: t.message }, 'error');
          if (t.details?.error === 'DeviceNotRegistered') bad.push(chunk[i].to);
        }
      });
      if (bad.length) {
        await Model.updateOne({ _id: id }, { $pull: { pushTokens: { $in: bad } } });
      }
    } catch (err) {
      log('expo:ERROR', { msg: err.message }, 'error');
    }
  }
}

async function deliver(m) {
  const Model = m.to === 'seller' ? mongoose.models.Seller : mongoose.models.User;
  log('emit:deliver', { to: m.to, id: String(m.id || ''), title: m.title, hasModel: !!Model });
  if (!Model || !m.id) return;

  const results = await Promise.allSettled([
    // In-app notification list (adjust field names if your model differs)
    Notification.create({
      ownerId: m.id,
      ownerType: m.to === 'seller' ? 'seller' : 'customer',
      title: m.title,
      body: m.body,
      route: m.route,
      read: false,
    }),

    // Mobile app push
    sendExpo(Model, m.id, m),

    // Browser push (works even when the browser is closed)
    sendWebPush(Model, m.id, {
      title: m.title,
      body: m.body,
      url: webUrlFor(m),
      tag: m.data?.bookingId ? `${m.data.type || m.to}-${m.data.bookingId}` : undefined,
    }),
  ]);

  // Show any part that threw, so nothing fails silently
  ['in-app', 'expo', 'web'].forEach((name, i) => {
    if (results[i].status === 'rejected') {
      log('emit:part-FAILED', { part: name, msg: results[i].reason?.message }, 'error');
    }
  });
}

// Usage: await emit('booking.created', { booking })
async function emit(eventName, payload) {
  log('emit:event', { eventName });
  try {
    const build = events[eventName];
    if (!build) return log('emit:unknown-event', { eventName }, 'error');

    const messages = await build(payload);
    log('emit:messages-built', { eventName, count: (messages || []).length });
    await Promise.allSettled((messages || []).map(deliver));
  } catch (err) {
    // A notification failure must never break the order/booking flow
    log('emit:ERROR', { eventName, msg: err.message }, 'error');
  }
}

module.exports = { emit };