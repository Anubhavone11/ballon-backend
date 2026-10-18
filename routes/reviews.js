const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const identifyUser = require('../middleware/identifyUser');
const c = require('../controllers/reviewController');

// authenticateToken is the ADMIN-side guard (that's why writing a review asked for an admin token).
// Customers are verified with identifyUser (same customer-JWT check your product page already uses),
// then we simply require that it found a user.
const requireUser = [
  identifyUser,
  (req, res, next) =>
    req.user ? next() : res.status(401).json({ message: 'Please sign in to continue', code: 'AUTH_REQUIRED' }),
];

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/reviews',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    format: 'webp',
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }, { quality: 'auto:good' }],
    public_id: () => `review-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files are allowed')),
});

const handleUpload = (req, res, next) =>
  upload.array('images', 5)(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 5 MB'
      : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT' ? 'You can upload up to 5 photos'
      : err.message || 'Photo upload failed';
    res.status(400).json({ message });
  });

/* Admin (declared first so they can never be shadowed by /:reviewId) */
router.get('/admin/all', authenticateToken, isAdmin, c.adminListReviews);
router.post('/admin/bulk', authenticateToken, isAdmin, c.adminBulk);
router.patch('/admin/:reviewId/status', authenticateToken, isAdmin, c.adminSetStatus);
router.post('/admin/:reviewId/reply', authenticateToken, isAdmin, c.adminReply);
router.delete('/admin/:reviewId', authenticateToken, isAdmin, c.adminDeleteReview);

/* Public (identifyUser only attaches req.user if a valid token exists) */
router.get('/product/:productId', identifyUser, c.getProductReviews);

/* Signed-in customers */
router.post('/product/:productId', requireUser, handleUpload, c.createReview);
router.put('/:reviewId', requireUser, handleUpload, c.updateReview);
router.delete('/:reviewId', requireUser, c.deleteReview);
router.post('/:reviewId/helpful', requireUser, c.toggleHelpful);

module.exports = router;