const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
 
// Configure Cloudinary storage for blog featured image
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/blog-images',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'blog-' + uniqueSuffix;
    }
  },
});
 
// Multer configuration for blog featured image
const uploadFeaturedImage = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1 // Only one featured image
  },
  fileFilter: (req, file, cb) => {
    // Check file type
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
}).single('featuredImage');
 
// Middleware to handle blog image upload
const handleBlogImageUpload = (req, res, next) => {
  uploadFeaturedImage(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        error: 'File upload error',
        details: err.message
      });
    } else if (err) {
      return res.status(500).json({
        success: false,
        error: 'File upload error',
        details: err.message
      });
    }
 
    // multer-storage-cloudinary already gives us the full hosted URL on req.file.path
    if (req.file) {
      req.file.generatedUrl = req.file.path; // Cloudinary CDN URL
    }
 
    next();
  });
};
 
module.exports = {
  handleBlogImageUpload,
  cloudinary
};
 