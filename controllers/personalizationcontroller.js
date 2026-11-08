'use strict';
const ProductView = require('../models/Productview');
const Wishlist = require('../models/Wishlist');
const UserCart = require('../models/Usercart');
const Product = require('../models/Product');

/* ── Assumptions about your Product schema (edit if names differ) ──────────
 *   category, subCategory, isActive, stock / inStock, averageRating, reviewCount, price
 * ────────────────────────────────────────────────────────────────────────── */
const CARD_FIELDS =
  'name price regularPrice images image brand stock inStock isActive isInstantAvailable instantDeliveryTime averageRating reviewCount rating reviews category subCategory';
const AVAILABLE = { isActive: { $ne: false }, stock: { $ne: 0 }, inStock: { $ne: false } };

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const MAX_HISTORY = 50;
const LOVED_WEIGHT = 4;
const CART_WEIGHT = 3;

const clampLimit = (v, def = 12) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), 24);
};

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[PERSONALIZATION ERROR]', err);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

/* ───────────────────────── Recently viewed (login required) ───────────────────────── */

exports.trackView = handle(async (req, res) => {
  const { productId } = req.params;
  if (!OBJECT_ID_RE.test(productId)) return res.status(400).json({ success: false, message: 'Invalid product id.' });

  const exists = await Product.exists({ _id: productId, isActive: { $ne: false } });
  if (!exists) return res.status(404).json({ success: false, message: 'Product not found.' });

  const upsert = () =>
    ProductView.updateOne(
      { user: req.userId, product: productId },
      { $set: { lastViewedAt: new Date() }, $inc: { viewCount: 1 } },
      { upsert: true }
    );
  try {
    await upsert();
  } catch (err) {
    if (err.code !== 11000) throw err;
    await upsert(); // concurrent first-view race
  }

  res.status(204).end();

  // Trim history in background
  ProductView.find({ user: req.userId })
    .sort({ lastViewedAt: -1 })
    .skip(MAX_HISTORY)
    .select('_id')
    .lean()
    .then((old) => (old.length ? ProductView.deleteMany({ _id: { $in: old.map((o) => o._id) } }) : null))
    .catch(() => {});
});

exports.getRecentlyViewed = handle(async (req, res) => {
  const limit = clampLimit(req.query.limit);
  const exclude = OBJECT_ID_RE.test(String(req.query.exclude || '')) ? String(req.query.exclude) : null;

  const views = await ProductView.find({ user: req.userId })
    .sort({ lastViewedAt: -1 })
    .limit(limit + 10)
    .select('product')
    .lean();

  const ids = views.map((v) => String(v.product)).filter((id) => id !== exclude);
  if (!ids.length) return res.json({ success: true, products: [] });

  const products = await Product.find({ _id: { $in: ids }, isActive: { $ne: false } }).select(CARD_FIELDS).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  res.json({ success: true, products: ids.map((id) => byId.get(id)).filter(Boolean).slice(0, limit) });
});

exports.clearRecentlyViewed = handle(async (req, res) => {
  await ProductView.deleteMany({ user: req.userId });
  res.status(204).end();
});

/* ───────────────────────── Recommendations ───────────────────────── */

const keyOf = (v) => (v === undefined || v === null ? null : String(v));

function buildProfile(seeds) {
  const cat = new Map();
  const sub = new Map();
  let priceSum = 0;
  let priceW = 0;

  const bump = (map, raw, w) => {
    const k = keyOf(raw);
    if (!k) return;
    const cur = map.get(k) || { raw, w: 0 };
    cur.w += w;
    map.set(k, cur);
  };

  for (const { product: p, weight } of seeds) {
    bump(cat, p.category, weight);
    bump(sub, p.subCategory, weight);
    if (Number.isFinite(p.price) && p.price > 0) {
      priceSum += p.price * weight;
      priceW += weight;
    }
  }
  return { cat, sub, avgPrice: priceW ? priceSum / priceW : null };
}

function scoreProduct(p, profile, maxCat, maxSub) {
  let score = 0;
  const c = profile.cat.get(keyOf(p.category));
  const s = profile.sub.get(keyOf(p.subCategory));
  if (c && maxCat) score += (c.w / maxCat) * 3;
  if (s && maxSub) score += (s.w / maxSub) * 4;

  const rating = Number(p.averageRating ?? p.rating ?? 0);
  const reviews = Number(p.reviewCount ?? p.reviews ?? 0);
  score += (Math.min(Math.max(rating, 0), 5) / 5) * 1.5;
  score += (Math.min(Math.log10(1 + Math.max(reviews, 0)), 3) / 3) * 1;

  if (profile.avgPrice && Number.isFinite(p.price) && p.price > 0) {
    score += (1 - Math.min(Math.abs(p.price - profile.avgPrice) / profile.avgPrice, 1)) * 1.5;
  }
  return score;
}

async function popularProducts(excludeIds, limit) {
  return Product.find({ ...AVAILABLE, _id: { $nin: excludeIds } })
    .sort({ averageRating: -1, reviewCount: -1, _id: -1 })
    .limit(limit)
    .select(CARD_FIELDS)
    .lean();
}

async function recommendFromProfile(profile, excludeIds, limit) {
  const cats = [...profile.cat.values()].map((v) => v.raw);
  const subs = [...profile.sub.values()].map((v) => v.raw);
  let ranked = [];

  if (cats.length || subs.length) {
    const or = [];
    if (cats.length) or.push({ category: { $in: cats } });
    if (subs.length) or.push({ subCategory: { $in: subs } });

    const candidates = await Product.find({ ...AVAILABLE, _id: { $nin: excludeIds }, $or: or })
      .sort({ averageRating: -1, reviewCount: -1 })
      .limit(120)
      .select(CARD_FIELDS)
      .lean();

    const maxCat = Math.max(0, ...[...profile.cat.values()].map((v) => v.w));
    const maxSub = Math.max(0, ...[...profile.sub.values()].map((v) => v.w));
    ranked = candidates
      .map((p) => ({ p, s: scoreProduct(p, profile, maxCat, maxSub) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p)
      .slice(0, limit);
  }

  if (ranked.length < limit) {
    const have = [...excludeIds, ...ranked.map((p) => p._id)];
    ranked = ranked.concat(await popularProducts(have, limit - ranked.length));
  }
  return ranked;
}

// Personalized "Recommended for you" (login required).
// Signals: loved items (strongest) + recent views (recency/repeat weighted) + cart.
exports.getRecommendations = handle(async (req, res) => {
  const limit = clampLimit(req.query.limit);

  const [views, loved, cart] = await Promise.all([
    ProductView.find({ user: req.userId }).sort({ lastViewedAt: -1 }).limit(30).select('product viewCount').lean(),
    Wishlist.find({ user: req.userId }).sort({ createdAt: -1 }).limit(50).select('product').lean(),
    UserCart.findOne({ user: req.userId }).select('items.product').lean(),
  ]);
  const cartIds = cart && cart.items ? cart.items.map((i) => i.product) : [];

  const weights = new Map();
  const add = (id, w) => weights.set(String(id), (weights.get(String(id)) || 0) + w);
  views.forEach((v, rank) => add(v.product, (1 + Math.log2(Math.max(v.viewCount || 1, 1))) * Math.pow(0.9, rank)));
  loved.forEach((l) => add(l.product, LOVED_WEIGHT));
  cartIds.forEach((id) => add(id, CART_WEIGHT));

  const seedProducts = weights.size
    ? await Product.find({ _id: { $in: [...weights.keys()] } }).select(CARD_FIELDS).lean()
    : [];
  const seeds = seedProducts.map((p) => ({ product: p, weight: weights.get(String(p._id)) || 1 }));

  // Don't recommend what they already love / have in cart / just looked at.
  const exclude = [
    ...new Set([
      ...loved.map((l) => String(l.product)),
      ...cartIds.map(String),
      ...views.slice(0, 12).map((v) => String(v.product)),
    ]),
  ];

  const products = await recommendFromProfile(buildProfile(seeds), exclude, limit);
  res.json({ success: true, personalized: seeds.length > 0, products });
});

// "You may also like" for a product page. PUBLIC (no personal data used).
exports.getSimilar = handle(async (req, res) => {
  const { productId } = req.params;
  if (!OBJECT_ID_RE.test(productId)) return res.status(400).json({ success: false, message: 'Invalid product id.' });
  const limit = clampLimit(req.query.limit);

  const seed = await Product.findById(productId).select(CARD_FIELDS).lean();
  if (!seed) return res.status(404).json({ success: false, message: 'Product not found.' });

  const products = await recommendFromProfile(buildProfile([{ product: seed, weight: 1 }]), [seed._id], limit);
  res.json({ success: true, products });
});