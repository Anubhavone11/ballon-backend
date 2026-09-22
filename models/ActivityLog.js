// models/ActivityLog.js
//
// Brand-new, standalone collection. Nothing about models/User.js changes.
// Every login/logout gets one document here, so "who logged in", "who
// didn't", and "how long were they in for" can all be answered without
// storing any of that state on the User document itself.

const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    action: {
      type: String,
      enum: [
        'login',
        'logout',
        'page_visit',          // generic page hit, e.g. home, category, cart
        'product_view',        // opened a product detail page
        'checkout_started',    // hit checkout with items in cart
        'checkout_completed',  // order placed successfully
      ],
      required: true,
      index: true,
    },

    // Only set on 'login' events - which auth path was used.
    method: { type: String, enum: ['otp', 'google'] },

    // Set on 'product_view' (which product), and optionally on checkout
    // events / page_visit if you want to tie a page hit to a product.
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', index: true },

    // Set on 'page_visit' (and useful as a fallback on any event) - the route hit.
    page: String,

    // Free-form extra data: cart items + total on checkout_started,
    // order id + amount on checkout_completed, etc. Keep it small.
    metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },

    ip: String,
    userAgent: String,

    // Only set on 'logout' events - computed from the matching last 'login'.
    sessionDurationMs: { type: Number, default: null },
  },
  { timestamps: true }
);

// Fast "latest event per user" and "this user's history" lookups.
activityLogSchema.index({ user: 1, createdAt: -1 });
// Fast "who viewed this product" / "most viewed products" lookups.
activityLogSchema.index({ product: 1, action: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);