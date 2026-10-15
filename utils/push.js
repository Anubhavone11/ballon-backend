// backend/utils/push.js
// npm install expo-server-sdk
const { Expo } = require('expo-server-sdk');
const Notification = require('../models/Notification');
const expo = new Expo();

/**
 * Notify one account (user OR seller/vendor):
 *   1. saves an in-app notification (shows in the bell + a toast, works on web AND phone)
 *   2. sends a phone push if the account has any saved push tokens
 *
 * @param {Model}  Model    Mongoose model (User, Seller or Vendor)
 * @param {string} id       _id of that account
 * @param {object} payload  { title, body, route }
 */
async function notify(Model, id, { title, body, route = '/account' }) {
  // 1. In-app notification (always)
  try {
    const ownerType = Model.modelName === 'User' ? 'customer' : 'seller';
    await Notification.create({ ownerType, ownerId: id, title, body, route });
  } catch (err) {
    console.error('IN-APP NOTIFY FAILED:', err.message);
  }

  // 2. Phone push (only if this account has tokens)
  try {
    const account = await Model.findById(id).select('pushTokens');
    const tokens = (account?.pushTokens || []).filter((t) => Expo.isExpoPushToken(t));
    if (!tokens.length) return;

    const messages = tokens.map((to) => ({
      to,
      title,
      body,
      sound: 'default',
      channelId: 'default',
      data: { route },
    }));

    const dead = [];
    for (const chunk of expo.chunkPushNotifications(messages)) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((tk, i) => {
        if (tk.status === 'error' && tk.details?.error === 'DeviceNotRegistered') {
          dead.push(chunk[i].to);
        }
      });
    }

    if (dead.length) {
      await Model.updateOne({ _id: id }, { $pull: { pushTokens: { $in: dead } } });
    }
  } catch (err) {
    // A failed push must never break an order or payment, so only log it
    console.error('PUSH FAILED:', err.message);
  }
}

module.exports = { notify };