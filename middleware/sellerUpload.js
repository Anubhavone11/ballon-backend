const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
 
// Configure Cloudinary storage for single passport verification photo
const passportStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/seller-profiles',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'seller-passport-' + uniqueSuffix;
    }
  },
});
 
// Multer implementation explicitly targeting the passportPhoto field
const uploadPassportPhoto = multer({
  storage: passportStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Please upload a valid image file.'), false);
    }
  }
}).single('passportPhoto'); // field key matches frontend
 
// Middleware for handling passport photo upload execution flow
const handleProfileImage = (req, res, next) => {
  uploadPassportPhoto(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File size must be smaller than 5MB.'
        });
      }
      return res.status(400).json({
        success: false,
        message: 'File upload error: ' + err.message
      });
    } else if (err) {
      return res.status(400).json({
        success: false,
        message: err.message
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
  handleProfileImage,
  cloudinary
};