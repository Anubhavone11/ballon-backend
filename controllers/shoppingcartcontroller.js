'use strict';
const UserCart = require('../models/Usercart');
const Product = require('../models/Product');

const MAX_QTY_PER_ITEM = 10;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const PRODUCT_FIELDS =
  'name price regularPrice images image brand stock inStock isActive isInstantAvailable instantDeliveryTime averageRating reviewCount rating reviews';

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isOutOfStock = (p) => p.stock === 0 || p.inStock === false;
const isListed = (p) => p.isActive !== false;
const maxQtyFor = (p) =>
  typeof p.stock === 'number' && p.stock > 0 ? Math.min(p.stock, MAX_QTY_PER_ITEM) : MAX_QTY_PER_ITEM;

function parseProductId(v) {
  if (typeof v !== 'string' || !OBJECT_ID_RE.test(v)) throw new ApiError(400, 'Invalid product id.');
  return v;
}

function parseQty(v, fallback) {
  if (v === undefined && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY_PER_ITEM) {
    throw new ApiError(400, `Quantity must be a whole number between 1 and ${MAX_QTY_PER_ITEM}.`);
  }
  return n;
}

async function loadSellableProduct(productId) {
  const product = await Product.findById(productId).select(PRODUCT_FIELDS).lean();
  if (!product || !isListed(product)) throw new ApiError(404, 'This product is no longer available.', 'NOT_FOUND');
  if (isOutOfStock(product)) throw new ApiError(409, 'This product is out of stock.', 'OUT_OF_STOCK');
  return product;
}

/** Load → mutate → save, retrying on version conflicts / duplicate-create races. */
async function mutateCart(userId, mutator, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      let cart = await UserCart.findOne({ user: userId });
      if (!cart) cart = new UserCart({ user: userId, items: [] });
      await mutator(cart);
      await cart.save();
      return cart;
    } catch (err) {
      const retryable = err.name === 'VersionError' || err.code === 11000;
      if (!retryable || i === attempts - 1) throw err;
    }
  }
  return null; // unreachable
}

/** Builds the response from LIVE product data - never trusts stored/client prices. */
async function buildCartView(cart) {
  const rawItems = cart ? cart.items : [];
  const ids = rawItems.map((i) => i.product);
  const products = ids.length ? await Product.find({ _id: { $in: ids } }).select(PRODUCT_FIELDS).lean() : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  const orphaned = [];
  let subtotal = 0;
  let savings = 0;
  let itemCount = 0;
  let hasUnavailable = false;

  for (const it of rawItems) {
    const p = byId.get(String(it.product));
    if (!p) {
      orphaned.push(it.product);
      continue;
    }
    const unitPrice = toNum(p.price);
    const regularPrice = toNum(p.regularPrice) > unitPrice ? toNum(p.regularPrice) : unitPrice;
    const purchasable = isListed(p) && !isOutOfStock(p);
    const maxQuantity = maxQtyFor(p);
    const quantity = Math.min(it.quantity, maxQuantity);

    if (purchasable) {
      subtotal += unitPrice * quantity;
      savings += (regularPrice - unitPrice) * quantity;
      itemCount += quantity;
    } else {
      hasUnavailable = true;
    }

    items.push({
      productId: String(p._id),
      product: p,
      quantity,
      quantityAdjusted: quantity !== it.quantity,
      maxQuantity,
      unitPrice,
      regularPrice,
      lineTotal: round2(unitPrice * quantity),
      purchasable,
      outOfStock: isOutOfStock(p),
      addedAt: it.addedAt,
    });
  }

  if (cart && orphaned.length) {
    // Products deleted from catalogue: clean up in background.
    UserCart.updateOne({ _id: cart._id }, { $pull: { items: { product: { $in: orphaned } } } }).catch(() => {});
  }

  return {
    items,
    itemCount,
    distinctCount: items.length,
    subtotal: round2(subtotal),
    savings: round2(savings),
    hasUnavailable,
    updatedAt: cart ? cart.updatedAt : null,
  };
}

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    }
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors || {})[0]?.message || 'Invalid cart data.';
      return res.status(400).json({ success: false, message: msg });
    }
    console.error('[CART ERROR]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

const send = async (res, cart) => res.json({ success: true, cart: await buildCartView(cart) });

exports.getCart = handle(async (req, res) => {
  const cart = await UserCart.findOne({ user: req.userId });
  await send(res, cart);
});

exports.addItem = handle(async (req, res) => {
  const productId = parseProductId(req.body?.productId);
  const qty = parseQty(req.body?.quantity, 1);
  const product = await loadSellableProduct(productId);
  const cap = maxQtyFor(product);

  const cart = await mutateCart(req.userId, (c) => {
    const existing = c.items.find((i) => String(i.product) === productId);
    const next = (existing ? existing.quantity : 0) + qty;
    if (next > cap) {
      throw new ApiError(409, `You can add at most ${cap} of this item.`, 'MAX_QTY');
    }
    if (existing) existing.quantity = next;
    else c.items.push({ product: productId, quantity: qty });
  });
  await send(res, cart);
});

exports.updateItem = handle(async (req, res) => {
  const productId = parseProductId(req.params.productId);
  const qty = parseQty(req.body?.quantity);
  const product = await loadSellableProduct(productId);
  const cap = maxQtyFor(product);
  if (qty > cap) throw new ApiError(409, `You can add at most ${cap} of this item.`, 'MAX_QTY');

  const cart = await mutateCart(req.userId, (c) => {
    const existing = c.items.find((i) => String(i.product) === productId);
    if (!existing) throw new ApiError(404, 'Item is not in your cart.', 'NOT_IN_CART');
    existing.quantity = qty;
  });
  await send(res, cart);
});

exports.removeItem = handle(async (req, res) => {
  const productId = parseProductId(req.params.productId);
  const cart = await UserCart.findOneAndUpdate(
    { user: req.userId },
    { $pull: { items: { product: productId } } },
    { new: true }
  );
  await send(res, cart);
});

exports.clearCart = handle(async (req, res) => {
  const cart = await UserCart.findOneAndUpdate({ user: req.userId }, { $set: { items: [] } }, { new: true });
  await send(res, cart);
});

// Merge items a visitor collected before logging in. Quantities are clamped silently.
exports.mergeItems = handle(async (req, res) => {
  const incoming = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
  const wanted = new Map();
  for (const row of incoming) {
    const id = row && typeof row.productId === 'string' ? row.productId : null;
    const q = Number(row && row.quantity);
    if (!id || !OBJECT_ID_RE.test(id) || !Number.isInteger(q) || q < 1) continue;
    wanted.set(id, Math.min((wanted.get(id) || 0) + q, MAX_QTY_PER_ITEM));
  }

  if (wanted.size === 0) {
    const cart = await UserCart.findOne({ user: req.userId });
    return send(res, cart);
  }

  const products = await Product.find({ _id: { $in: [...wanted.keys()] } }).select(PRODUCT_FIELDS).lean();
  const sellable = new Map(products.filter((p) => isListed(p) && !isOutOfStock(p)).map((p) => [String(p._id), p]));

  const cart = await mutateCart(req.userId, (c) => {
    for (const [id, qty] of wanted) {
      const p = sellable.get(id);
      if (!p) continue;
      const cap = maxQtyFor(p);
      const existing = c.items.find((i) => String(i.product) === id);
      if (existing) existing.quantity = Math.min(existing.quantity + qty, cap);
      else if (c.items.length < 50) c.items.push({ product: id, quantity: Math.min(qty, cap) });
    }
  });
  await send(res, cart);
});