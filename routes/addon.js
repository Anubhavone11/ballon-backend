const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const addonController = require('../controllers/addonController');
const { auth } = require('../middleware/auth');
 
// Configure Cloudinary storage (replaces local diskStorage)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/addons',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'addon-' + uniqueSuffix;
    }
  },
});
 
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});
 
// Public routes (for frontend to fetch active add-ons)
router.get('/', addonController.getAllAddons);
router.get('/:id', addonController.getAddonById);
 
// Image upload endpoint (protected)
router.post('/upload', auth, upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }
 
    // multer-storage-cloudinary already gives us the full hosted CDN URL on req.file.path
    const imageUrl = req.file.path;
 
    res.status(200).json({
      success: true,
      imageUrl: imageUrl
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message
    });
  }
});
 
// Admin routes (protected)
router.post('/', auth, addonController.createAddon);
router.put('/:id', auth, addonController.updateAddon);
router.delete('/:id', auth, addonController.deleteAddon);
router.patch('/:id/toggle-status', auth, addonController.toggleAddonStatus);
 
module.exports = router;