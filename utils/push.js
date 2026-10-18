// backend/utils/push.js
const { Expo } = require('expo-server-sdk');
const Notification = require('../models/Notification');
const expo = new Expo();

/**
 * Notify one account (user OR seller/vendor):
 *   1. Saves an in-app notification (bell + toast, works on web AND phone)
 *   2. Sends a high-priority phone push if the account has saved push tokens
 *
 * @param {Model}  Model    Mongoose model (User, Seller or Vendor)
 * @param {string} id       _id of that account
 * @param {object} payload  { title, body, route, channelId, categoryId, priority, sound,
 *                            data, dataOnly, record, ttl, interruptionLevel }
 */
async function notify(Model, id, payload = {}) {
  const {
    title,
    body,
    route = '/account',
    channelId = 'default',
    categoryId,
    priority = 'high',
    sound = 'default',
    data = {},
    dataOnly = false,       // true => silent data push; the app builds the call screen itself
    record = !dataOnly,     // save to the in-app bell?
    ttl,                    // seconds the push stays valid (stops stale "calls")
    interruptionLevel,      // iOS: 'time-sensitive'
  } = payload;

  // 1. In-app notification (stored in MongoDB)
  if (record) {
    try {
      const ownerType = Model.modelName === 'User' ? 'customer' : 'seller';
      await Notification.create({ ownerType, ownerId: id, title, body, route });
    } catch (err) {
      console.error('[NOTIFY] In-app record failed:', err.message);
    }
  }

  // 2. Physical device push (only if account has registered tokens)
  try {
    const account = await Model.findById(id).select('pushTokens');
    if (!account) {
      console.warn(`[PUSH] Skipped: ${Model.modelName} ${id} not found.`);
      return;
    }

    const tokens = (account.pushTokens || []).filter((t) => Expo.isExpoPushToken(t));
    if (!tokens.length) {
      console.log(`[PUSH] ${Model.modelName} ${id} has no registered push tokens.`);
      return;
    }

    const messages = tokens.map((to) => {
      const msg = { to, priority }; // 'high' wakes the device out of Android Doze
      if (ttl) msg.ttl = ttl;

      if (dataOnly) {
        // No title/body => Android hands it to the background task instead of showing a plain banner
        msg.data = { ...data, route, title, body };
        msg._contentAvailable = true; // iOS background wake (best effort)
      } else {
        msg.title = title;
        msg.body = body;
        msg.sound = sound;
        msg.channelId = channelId;
        msg.data = { ...data, route };
        if (categoryId) msg.categoryId = categoryId;
        if (interruptionLevel) msg.interruptionLevel = interruptionLevel;
      }
      return msg;
    });

    const dead = [];
    const chunks = expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      console.log(`[PUSH] Dispatched to ${chunk.length} device(s). Tickets:`, JSON.stringify(tickets));

      tickets.forEach((tk, i) => {
        if (tk.status === 'error' && tk.details?.error === 'DeviceNotRegistered') {
          dead.push(chunk[i].to);
        }
      });
    }

    // Clean up stale/uninstalled device tokens
    if (dead.length) {
      await Model.updateOne({ _id: id }, { $pull: { pushTokens: { $in: dead } } });
      console.log(`[PUSH] Pruned ${dead.length} expired token(s) from account ${id}`);
    }
  } catch (err) {
    // Push errors must never disrupt business logic (orders/payments)
    console.error('[PUSH] Failed dispatching mobile push:', err.message);
  }
}

module.exports = { notify };