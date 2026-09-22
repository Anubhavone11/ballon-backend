// middleware/trackActivity.js
//
// Drop this on any route to log the visit/action. Runs AFTER the response
// is sent (res.on('finish')) so it never adds latency to the actual page
// or API call, and only logs on success (status < 400).
//
// Usage examples:
//   router.get('/:id', identifyUser, trackActivity('product_view', {
//     product: (req) => req.params.id,
//   }), getProductById);
//
//   router.post('/checkout', identifyUser, auth, trackActivity('checkout_started', {
//     metadata: (req) => ({ itemCount: req.body.items?.length, total: req.body.total }),
//   }), startCheckout);
//
//   router.get('/', identifyUser, trackActivity('page_visit'), getHomePage);

const ActivityLog = require('../models/ActivityLog');

function trackActivity(action, extractors = {}) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return; // don't log failed requests
      if (!req.user?.id) return;          // guest with no token - nothing to attribute this to

      const entry = {
        user: req.user.id,
        action,
        page: req.originalUrl,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      };

      if (typeof extractors.product === 'function') {
        entry.product = extractors.product(req, res);
      }
      if (typeof extractors.metadata === 'function') {
        entry.metadata = extractors.metadata(req, res);
      }

      ActivityLog.create(entry).catch((e) => console.error(`ActivityLog (${action}) failed:`, e.message));
    });
    next();
  };
}

module.exports = trackActivity;