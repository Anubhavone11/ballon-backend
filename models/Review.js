const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema(
  { url: { type: String, required: true }, publicId: { type: String, required: true } },
  { _id: false }
);

const reviewSchema = new mongoose.Schema(
  {
    // `user` is optional ONLY so that old reviews (email-only) keep working.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userEmail: { type: String, lowercase: true, trim: true, default: '' },
    userName: { type: String, required: true, trim: true, maxlength: 100 },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    stars: { type: Number, required: true, min: 1, max: 5 },
    reviewTitle: { type: String, trim: true, maxlength: 100, default: '' },
    reviewDescription: { type: String, required: true, trim: true, maxlength: 1000 },
    images: {
      type: [imageSchema],
      default: [],
      validate: [(v) => v.length <= 5, 'A review can have at most 5 photos'],
    },
    // Old documents without this field are treated as approved (see VISIBLE in controller)
    status: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'approved' },
    helpfulBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    helpfulCount: { type: Number, default: 0 },
    adminReply: {
      text: { type: String, trim: true, maxlength: 1000 },
      repliedAt: { type: Date },
    },
    edited: { type: Boolean, default: false },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One review per user per product (partial => legacy docs without `user` never collide)
reviewSchema.index(
  { user: 1, product: 1 },
  { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } }
);
reviewSchema.index({ product: 1, status: 1, createdAt: -1 });
reviewSchema.index({ product: 1, status: 1, helpfulCount: -1 });
reviewSchema.index({ product: 1, status: 1, stars: 1 });
reviewSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);