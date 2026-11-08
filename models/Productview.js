'use strict';
const mongoose = require('mongoose');

// One row per (user, product). Logged-in users only.
// No schema defaults on viewCount/lastViewedAt: they are written with $inc/$set in upserts.
const productViewSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  viewCount: { type: Number },
  lastViewedAt: { type: Date },
});

productViewSchema.index({ user: 1, product: 1 }, { unique: true });
productViewSchema.index({ user: 1, lastViewedAt: -1 });
productViewSchema.index({ lastViewedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }); // 90 days

module.exports = mongoose.models.ProductView || mongoose.model('ProductView', productViewSchema);