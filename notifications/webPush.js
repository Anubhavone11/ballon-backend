const webpush = require('web-push');
const { log } = require('../utils/pushLog');

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;

if (publicKey && privateKey) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@decoryy.com',
    publicKey,
    privateKey
  );
  log('server:vapid-ok');
} else {
  log('server:vapid-MISSING', { hasPublic: !!publicKey, hasPrivate: !!privateKey }, 'error');
}

function webUrlFor(m) {
  if (m.to === 'seller') return '/dashboard/profile';
  return m.route || '/account';
}

async function sendWebPush(Model, id, { title, body, url, tag }) {
  const who = String(id || '');
  log('send:called', { who, title });

  if (!publicKey || !privateKey) return log('send:skipped-no-vapid', { who }, 'error');
  if (!Model || !id) return log('send:skipped-no-model-or-id', { who, hasModel: !!Model }, 'error');

  const doc = await Model.findById(id).select('webPushSubscriptions').lean();
  const subs = doc?.webPushSubscriptions || [];
  log('send:subscriptions-found', { who, model: Model.modelName, count: subs.length });
  if (!subs.length) return;

  const payload = JSON.stringify({ title, body, url: url || '/', tag });
  const dead = [];

  await Promise.all(
    subs.map(async (sub) => {
      const host = (() => { try { return new URL(sub.endpoint).host; } catch { return '?'; } })();
      try {
        const r = await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24 });
        log('send:ok', { who, host, status: r.statusCode });
      } catch (err) {
        log('send:FAILED', { who, host, status: err.statusCode, msg: err.body || err.message }, 'error');
        if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
      }
    })
  );

  if (dead.length) {
    await Model.updateOne(
      { _id: id },
      { $pull: { webPushSubscriptions: { endpoint: { $in: dead } } } }
    );
    log('send:removed-dead', { who, count: dead.length });
  }
}

module.exports = { sendWebPush, webUrlFor, publicKey };