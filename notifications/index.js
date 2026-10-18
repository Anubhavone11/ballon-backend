// backend/notifications/index.js
//
// One entry point for every notification in the app:
//
//   const { emit } = require('../notifications');
//   emit('order.created', { order, req, seller, commission });
//
// emit() never throws and never blocks, so a notification problem can
// never break an order, payment or booking.

const mongoose = require('mongoose');
const { notify } = require('../utils/push');
const events = require('./events');

// Which Mongoose model each recipient type lives in
const MODEL_FOR = { customer: 'User', seller: 'Seller', vendor: 'Vendor' };

async function emit(name, data = {}) {
  try {
    const build = events[name];
    if (!build) {
      console.warn(`[NOTIFY] unknown event "${name}"`);
      return;
    }

    const messages = await build(data);
    if (!messages.length) {
      console.log(`[NOTIFY] ${name}: nobody to notify`);
      return;
    }

    for (const m of messages) {
      const Model = mongoose.models[MODEL_FOR[m.to]];
      if (!Model || !m.id) {
        console.log(`[NOTIFY] ${name} -> ${m.to}: skipped (no "${MODEL_FOR[m.to]}" model or no id)`);
        continue;
      }

      // Pass EVERYTHING through (channelId, categoryId, priority, data, dataOnly, ttl...)
      const { to, id, ...payload } = m;
      await notify(Model, id, payload);
      console.log(`[NOTIFY] ${name} -> ${to}`);
    }
  } catch (err) {
    console.error(`[NOTIFY] ${name} failed:`, err.message);
  }
}

module.exports = { emit };