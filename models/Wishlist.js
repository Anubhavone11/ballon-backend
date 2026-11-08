'use strict';
const mongoose = require('mongoose');

// "Loved" products. One row per (user, product).
const wishlistSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  createdAt: { type: Date },
});

wishlistSchema.index({ user: 1, product: 1 }, { unique: true });
wishlistSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.Wishlist || mongoose.model('Wishlist', wishlistSchema);