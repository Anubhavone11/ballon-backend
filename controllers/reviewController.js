const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const User = require('../models/User');
const cloudinary = require('../config/cloudinary');

const { ObjectId } = mongoose.Types;
const MAX_IMAGES = 5;
// Set REVIEW_AUTO_APPROVE=false in .env to hold every new/edited review for admin approval
const AUTO_APPROVE = process.env.REVIEW_AUTO_APPROVE !== 'false';
// $nin also matches legacy docs that have no `status` field
const VISIBLE = { $nin: ['pending', 'rejected'] };
const SORTS = {
  recent: { createdAt: -1 },
  helpful: { helpfulCount: -1, createdAt: -1 },
  high: { stars: -1, createdAt: -1 },
  low: { stars: 1, createdAt: -1 },
};

/* ───────────────────────────── helpers ───────────────────────────── */
const isId = (v) => mongoose.isValidObjectId(v);
const uidOf = (req) => {
  const u = req.user;
  if (!u) return null;
  const id = u._id || u.id || u.userId;
  return id ? String(id) : null;
};
const nameOf = (u) =>
  u?.name || u?.fullName || [u?.firstName, u?.lastName].filter(Boolean).join(' ') ||
  (u?.email ? u.email.split('@')[0] : '') || 'Customer';

const destroyImages = (publicIds = []) =>
  Promise.allSettled(publicIds.filter(Boolean).map((id) => cloudinary.uploader.destroy(id)));
const filesToImages = (files = []) => files.map((f) => ({ url: f.path, publicId: f.filename }));
const cleanupFiles = (files = []) => destroyImages(files.map((f) => f.filename));

const isOwner = (review, req) => {
  const uid = uidOf(req);
  if (review.user && uid) return String(review.user) === uid;
  const email = req.user?.email?.toLowerCase();
  return !review.user && !!email && review.userEmail === email; // legacy email-only reviews
};

const validateBody = ({ stars, reviewTitle, reviewDescription }) => {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return 'Please select a rating from 1 to 5 stars';
  if (reviewTitle.length > 100) return 'Title can be at most 100 characters';
  if (reviewDescription.length < 10 || reviewDescription.length > 1000)
    return 'Review must be between 10 and 1000 characters';
  return null;
};

const toPublic = (r, uid) => ({
  _id: r._id,
  userName: r.userName,
  stars: r.stars,
  reviewTitle: r.reviewTitle || '',
  reviewDescription: r.reviewDescription,
  images: (r.images || []).map((i) => ({ url: i.url, publicId: i.publicId })),
  helpfulCount: r.helpfulCount || 0,
  hasVoted: !!uid && (r.helpfulBy || []).some((id) => String(id) === uid),
  isMine: !!uid && !!r.user && String(r.user) === uid,
  status: r.status || 'approved',
  edited: !!r.edited,
  adminReply: r.adminReply?.text ? { text: r.adminReply.text, repliedAt: r.adminReply.repliedAt } : null,
  createdAt: r.createdAt,
});

const getSummary = async (productId) => {
  const rows = await Review.aggregate([
    { $match: { product: new ObjectId(String(productId)), status: VISIBLE } },
    { $group: { _id: '$stars', count: { $sum: 1 } } },
  ]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0, sum = 0;
  rows.forEach(({ _id, count }) => { distribution[_id] = count; total += count; sum += _id * count; });
  return { total, average: total ? Math.round((sum / total) * 10) / 10 : 0, distribution };
};

// Keeps Product.rating / Product.reviews in sync (fields your product page already reads)
const updateProductRating = async (productId) => {
  try {
    const { total, average } = await getSummary(productId);
    await Product.findByIdAndUpdate(productId, { rating: average, reviews: total });
  } catch (e) {
    console.error('updateProductRating failed:', e.message);
  }
};

/* ───────────────────────────── public / user ───────────────────────────── */
const getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!isId(productId)) return res.status(400).json({ message: 'Invalid product id' });
    if (!(await Product.exists({ _id: productId }))) return res.status(404).json({ message: 'Product not found' });

    const uid = uidOf(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
    const sort = SORTS[req.query.sort] || SORTS.recent;

    const filter = { product: productId, status: VISIBLE };
    const stars = parseInt(req.query.stars, 10);
    if (stars >= 1 && stars <= 5) filter.stars = stars;
    if (req.query.withPhotos === 'true') filter['images.0'] = { $exists: true };

    const [rows, filteredTotal] = await Promise.all([
      Review.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).select('-userEmail').lean(),
      Review.countDocuments(filter),
    ]);

    const payload = {
      reviews: rows.map((r) => toPublic(r, uid)),
      pagination: { page, limit, total: filteredTotal, hasMore: page * limit < filteredTotal },
    };

    if (page === 1) {
      const [summary, photoRows, mine] = await Promise.all([
        getSummary(productId),
        Review.find({ product: productId, status: VISIBLE, 'images.0': { $exists: true } })
          .sort({ createdAt: -1 }).limit(12).select('images').lean(),
        uid ? Review.findOne({ product: productId, user: uid }).select('-userEmail').lean() : null,
      ]);
      payload.summary = summary;
      payload.photos = photoRows.flatMap((r) => r.images.map((i) => i.url)).slice(0, 12);
      payload.myReview = mine ? toPublic(mine, uid) : null;
    }
    res.json(payload);
  } catch (e) {
    console.error('getProductReviews:', e);
    res.status(500).json({ message: 'Could not load reviews' });
  }
};

const createReview = async (req, res) => {
  const files = req.files || [];
  try {
    const uid = uidOf(req);
    const { productId } = req.params;
    if (!uid) { await cleanupFiles(files); return res.status(401).json({ message: 'Please sign in to write a review' }); }
    if (!isId(productId)) { await cleanupFiles(files); return res.status(400).json({ message: 'Invalid product id' }); }

    const body = {
      stars: Number(req.body.stars),
      reviewTitle: String(req.body.reviewTitle ?? '').trim(),
      reviewDescription: String(req.body.reviewDescription ?? '').trim(),
    };
    const err = validateBody(body);
    if (err) { await cleanupFiles(files); return res.status(400).json({ message: err }); }

    if (!(await Product.exists({ _id: productId }))) {
      await cleanupFiles(files);
      return res.status(404).json({ message: 'Product not found' });
    }
    if (await Review.exists({ user: uid, product: productId })) {
      await cleanupFiles(files);
      return res.status(409).json({ message: 'You have already reviewed this product. Please edit your review.' });
    }

    const dbUser = await User.findById(uid).lean();
    const review = await Review.create({
      user: uid,
      userName: nameOf(dbUser || req.user),
      userEmail: (dbUser?.email || req.user?.email || '').toLowerCase(),
      product: productId,
      ...body,
      images: filesToImages(files),
      status: AUTO_APPROVE ? 'approved' : 'pending',
    });

    await updateProductRating(productId);
    res.status(201).json({
      message: AUTO_APPROVE ? 'Thanks for your review!' : 'Thanks! Your review will appear after approval.',
      review: toPublic(review.toObject(), uid),
    });
  } catch (e) {
    await cleanupFiles(files);
    if (e.code === 11000) return res.status(409).json({ message: 'You have already reviewed this product.' });
    console.error('createReview:', e);
    res.status(500).json({ message: 'Could not save your review' });
  }
};

const updateReview = async (req, res) => {
  const files = req.files || [];
  try {
    const { reviewId } = req.params;
    if (!isId(reviewId)) { await cleanupFiles(files); return res.status(400).json({ message: 'Invalid review id' }); }

    const review = await Review.findById(reviewId);
    if (!review) { await cleanupFiles(files); return res.status(404).json({ message: 'Review not found' }); }
    if (!isOwner(review, req)) { await cleanupFiles(files); return res.status(403).json({ message: 'You can only edit your own review' }); }

    const body = {
      stars: Number(req.body.stars),
      reviewTitle: String(req.body.reviewTitle ?? '').trim(),
      reviewDescription: String(req.body.reviewDescription ?? '').trim(),
    };
    const err = validateBody(body);
    if (err) { await cleanupFiles(files); return res.status(400).json({ message: err }); }

    let removeIds = req.body.removeImageIds || [];
    if (typeof removeIds === 'string') { try { removeIds = JSON.parse(removeIds); } catch { removeIds = []; } }
    if (!Array.isArray(removeIds)) removeIds = [];

    const kept = review.images.filter((i) => !removeIds.includes(i.publicId));
    if (kept.length + files.length > MAX_IMAGES) {
      await cleanupFiles(files);
      return res.status(400).json({ message: `A review can have at most ${MAX_IMAGES} photos` });
    }
    const removed = review.images.filter((i) => removeIds.includes(i.publicId)).map((i) => i.publicId);

    Object.assign(review, body, { images: [...kept, ...filesToImages(files)], edited: true });
    if (!AUTO_APPROVE) review.status = 'pending';
    await review.save();
    await destroyImages(removed);
    await updateProductRating(review.product);

    res.json({ message: 'Review updated', review: toPublic(review.toObject(), uidOf(req)) });
  } catch (e) {
    await cleanupFiles(files);
    console.error('updateReview:', e);
    res.status(500).json({ message: 'Could not update your review' });
  }
};

const deleteReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    if (!isId(reviewId)) return res.status(400).json({ message: 'Invalid review id' });
    const review = await Review.findById(reviewId);
    if (!review) return res.status(404).json({ message: 'Review not found' });
    if (!isOwner(review, req)) return res.status(403).json({ message: 'You can only delete your own review' });

    await review.deleteOne();
    await destroyImages(review.images.map((i) => i.publicId));
    await updateProductRating(review.product);
    res.json({ message: 'Review deleted' });
  } catch (e) {
    console.error('deleteReview:', e);
    res.status(500).json({ message: 'Could not delete the review' });
  }
};

const toggleHelpful = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const uid = uidOf(req);
    if (!uid) return res.status(401).json({ message: 'Please sign in' });
    if (!isId(reviewId)) return res.status(400).json({ message: 'Invalid review id' });

    const review = await Review.findOne({ _id: reviewId, status: VISIBLE }).select('user helpfulBy');
    if (!review) return res.status(404).json({ message: 'Review not found' });
    if (review.user && String(review.user) === uid)
      return res.status(400).json({ message: "You can't vote on your own review" });

    const has = review.helpfulBy.some((id) => String(id) === uid);
    const updated = await Review.findByIdAndUpdate(
      reviewId,
      has ? { $pull: { helpfulBy: uid } } : { $addToSet: { helpfulBy: uid } },
      { new: true }
    ).select('helpfulBy');
    const helpfulCount = updated.helpfulBy.length;
    await Review.updateOne({ _id: reviewId }, { helpfulCount });
    res.json({ hasVoted: !has, helpfulCount });
  } catch (e) {
    console.error('toggleHelpful:', e);
    res.status(500).json({ message: 'Could not update vote' });
  }
};

/* ───────────────────────────── admin ───────────────────────────── */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const adminListReviews = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = {};
    const { status, stars, product, q, withPhotos } = req.query;
    if (status === 'approved') filter.status = VISIBLE;
    else if (['pending', 'rejected'].includes(status)) filter.status = status;
    if (parseInt(stars, 10) >= 1) filter.stars = parseInt(stars, 10);
    if (product && isId(product)) filter.product = product;
    if (withPhotos === 'true') filter['images.0'] = { $exists: true };
    if (q && q.trim()) {
      const rx = new RegExp(escapeRegex(q.trim().slice(0, 60)), 'i');
      filter.$or = [{ userName: rx }, { userEmail: rx }, { reviewTitle: rx }, { reviewDescription: rx }];
    }

    const [reviews, total, counts] = await Promise.all([
      Review.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('product', 'name image images').lean(),
      Review.countDocuments(filter),
      Review.aggregate([{ $group: { _id: { $ifNull: ['$status', 'approved'] }, count: { $sum: 1 } } }]),
    ]);
    const statusCounts = { approved: 0, pending: 0, rejected: 0 };
    counts.forEach((c) => { statusCounts[c._id] = c.count; });

    res.json({ reviews, statusCounts, pagination: { page, limit, total, hasMore: page * limit < total } });
  } catch (e) {
    console.error('adminListReviews:', e);
    res.status(500).json({ message: 'Could not load reviews' });
  }
};

const adminSetStatus = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { status } = req.body;
    if (!isId(reviewId)) return res.status(400).json({ message: 'Invalid review id' });
    if (!['approved', 'pending', 'rejected'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    const review = await Review.findByIdAndUpdate(reviewId, { status }, { new: true });
    if (!review) return res.status(404).json({ message: 'Review not found' });
    await updateProductRating(review.product);
    res.json({ message: `Review ${status}`, review });
  } catch (e) {
    console.error('adminSetStatus:', e);
    res.status(500).json({ message: 'Could not update status' });
  }
};

const adminReply = async (req, res) => {
  try {
    const { reviewId } = req.params;
    if (!isId(reviewId)) return res.status(400).json({ message: 'Invalid review id' });
    const text = String(req.body.text ?? '').trim();
    if (text.length > 1000) return res.status(400).json({ message: 'Reply can be at most 1000 characters' });
    const update = text ? { adminReply: { text, repliedAt: new Date() } } : { $unset: { adminReply: 1 } };
    const review = await Review.findByIdAndUpdate(reviewId, update, { new: true });
    if (!review) return res.status(404).json({ message: 'Review not found' });
    res.json({ message: text ? 'Reply saved' : 'Reply removed', review });
  } catch (e) {
    console.error('adminReply:', e);
    res.status(500).json({ message: 'Could not save reply' });
  }
};

const adminDeleteReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    if (!isId(reviewId)) return res.status(400).json({ message: 'Invalid review id' });
    const review = await Review.findByIdAndDelete(reviewId);
    if (!review) return res.status(404).json({ message: 'Review not found' });
    await destroyImages(review.images.map((i) => i.publicId));
    await updateProductRating(review.product);
    res.json({ message: 'Review deleted' });
  } catch (e) {
    console.error('adminDeleteReview:', e);
    res.status(500).json({ message: 'Could not delete review' });
  }
};

const adminBulk = async (req, res) => {
  try {
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(isId))
      return res.status(400).json({ message: 'Provide 1-100 valid review ids' });
    if (!['approve', 'reject', 'delete'].includes(action)) return res.status(400).json({ message: 'Invalid action' });

    const reviews = await Review.find({ _id: { $in: ids } }).select('product images');
    const productIds = [...new Set(reviews.map((r) => String(r.product)))];

    if (action === 'delete') {
      await Review.deleteMany({ _id: { $in: ids } });
      await destroyImages(reviews.flatMap((r) => r.images.map((i) => i.publicId)));
    } else {
      await Review.updateMany({ _id: { $in: ids } }, { status: action === 'approve' ? 'approved' : 'rejected' });
    }
    await Promise.all(productIds.map(updateProductRating));
    res.json({ message: `${reviews.length} review(s) updated`, affected: reviews.length });
  } catch (e) {
    console.error('adminBulk:', e);
    res.status(500).json({ message: 'Bulk action failed' });
  }
};

module.exports = {
  getProductReviews, createReview, updateReview, deleteReview, toggleHelpful,
  adminListReviews, adminSetStatus, adminReply, adminDeleteReview, adminBulk,
};