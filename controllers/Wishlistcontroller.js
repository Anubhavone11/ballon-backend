'use strict';
const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const MAX_ITEMS = 500;
const CARD_FIELDS =
  'name price regularPrice images image brand stock inStock isActive isInstantAvailable instantDeliveryTime averageRating reviewCount rating reviews category subCategory';

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[WISHLIST ERROR]', err);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

// Light call used to paint hearts: just the ids.
exports.getIds = handle(async (req, res) => {
  const rows = await Wishlist.find({ user: req.userId }).sort({ createdAt: -1 }).limit(MAX_ITEMS).select('product').lean();
  res.json({ success: true, ids: rows.map((r) => String(r.product)) });
});

// Full products for a "My favourites" page, newest first.
exports.list = handle(async (req, res) => {
  const rows = await Wishlist.find({ user: req.userId }).sort({ createdAt: -1 }).limit(100).select('product').lean();
  const ids = rows.map((r) => String(r.product));
  if (!ids.length) return res.json({ success: true, products: [] });

  const products = await Product.find({ _id: { $in: ids }, isActive: { $ne: false } }).select(CARD_FIELDS).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  res.json({ success: true, products: ids.map((id) => byId.get(id)).filter(Boolean) });
});

exports.add = handle(async (req, res) => {
  const { productId } = req.params;
  if (!OBJECT_ID_RE.test(productId)) return res.status(400).json({ success: false, message: 'Invalid product id.' });

  const exists = await Product.exists({ _id: productId, isActive: { $ne: false } });
  if (!exists) return res.status(404).json({ success: false, message: 'Product not found.' });

  const already = await Wishlist.exists({ user: req.userId, product: productId });
  if (!already) {
    const count = await Wishlist.countDocuments({ user: req.userId });
    if (count >= MAX_ITEMS) {
      return res.status(409).json({ success: false, message: `You can save up to ${MAX_ITEMS} items.` });
    }
    try {
      await Wishlist.updateOne(
        { user: req.userId, product: productId },
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      if (err.code !== 11000) throw err; // double-tap race: already saved, fine
    }
  }
  res.json({ success: true, wished: true });
});

exports.remove = handle(async (req, res) => {
  const { productId } = req.params;
  if (!OBJECT_ID_RE.test(productId)) return res.status(400).json({ success: false, message: 'Invalid product id.' });
  await Wishlist.deleteOne({ user: req.userId, product: productId });
  res.json({ success: true, wished: false });
});