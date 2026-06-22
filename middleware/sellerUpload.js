const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const sellerProfilesDir = path.join(__dirname, '../data/seller-profiles');

if (!fs.existsSync(sellerProfilesDir)) {
  fs.mkdirSync(sellerProfilesDir, { recursive: true });
}

// Configure storage for single passport verification photo
const passportStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, sellerProfilesDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'seller-passport-' + uniqueSuffix + ext);
  }
});

// Multer implementation explicitly targeting the passportPhoto field
const uploadPassportPhoto = multer({
  storage: passportStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // Optimized standard 5MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Please upload a valid image file.'), false);
    }
  }
}).single('passportPhoto'); // ◄ FIXED: Field key token matches frontend directly now

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

    // ✨ FIX: Construct a complete URL including the exact filename and extension
    if (req.file) {
      const baseUrl = process.env.BACKEND_URL || 'http://localhost:5175';
      
      // We append the clean forward-slash path structure using the exact generated filename
      req.file.generatedUrl = `${baseUrl}/data/seller-profiles/${req.file.filename}`;
      
      // Keep req.file.path intact as the absolute fallback just in case your controller reads it
      req.file.path = `${baseUrl}/data/seller-profiles/${req.file.filename}`;
    }

    next();
  });
};
module.exports = {
  handleProfileImage,
  cloudinary: null
};