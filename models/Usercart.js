'use strict';
const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1, max: 99, default: 1 },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userCartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
  },
  { timestamps: true }
);

userCartSchema.path('items').validate(
  (arr) => arr.length <= 50,
  'Cart cannot hold more than 50 different products.'
);

module.exports = mongoose.models.UserCart || mongoose.model('UserCart', userCartSchema);