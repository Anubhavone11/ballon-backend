const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary'); // your existing cloudinary v2 config (same one the passport upload uses)

const MAX_FILES = 8;                      // per request; keep >= MAX_COMPLETION_IMAGES in bookingController
const MAX_FILE_SIZE = 10 * 1024 * 1024;   // 10 MB, phone photos are often 3-8 MB
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req) => ({
    folder: `decoryy/booking-completion/${req.params.bookingId || 'misc'}`,
    resource_type: 'image',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
    // Resize + compress on Cloudinary so big phone photos don't slow the dashboard down
    transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
  })
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    const err = new Error('Only JPG, PNG, WebP or HEIC photos are allowed.');
    err.code = 'INVALID_FILE_TYPE';
    cb(err);
  }
});

/**
 * Express middleware: accepts up to MAX_FILES photos in the "images" field.
 * Uploaded files land on req.files with { path (url), filename (public_id) }.
 * Upload problems come back as clean JSON instead of a raw Express error page.
 */
const uploadBookingPhotos = (req, res, next) => {
  upload.array('images', MAX_FILES)(req, res, (err) => {
    if (!err) return next();

    let message = err.message || 'Photo upload failed.';

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        message = `Each photo must be under ${MAX_FILE_SIZE / (1024 * 1024)} MB.`;
      } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        message = `You can upload up to ${MAX_FILES} photos at a time.`;
      }
    } else if (err.code !== 'INVALID_FILE_TYPE') {
      console.error('uploadBookingPhotos error:', err);
      message = 'Photo upload failed. Please try again.';
    }

    return res.status(400).json({ success: false, message });
  });
};

/**
 * Delete photos that were already uploaded to Cloudinary when the request is
 * later rejected (wrong booking, over the photo limit, etc.), so we don't
 * leave orphaned files behind.
 */
const discardUploadedFiles = async (files = []) => {
  await Promise.allSettled(
    files
      .filter((f) => f && f.filename)
      .map((f) => cloudinary.uploader.destroy(f.filename))
  );
};

module.exports = { uploadBookingPhotos, discardUploadedFiles, MAX_FILES };