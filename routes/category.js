const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { isAdmin, authenticateToken } = require('../middleware/auth');
const categoryController = require('../controllers/categoryController');
 
const SubCategory = require('../models/SubCategory');
 
// Configure Cloudinary storage (replaces local diskStorage)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/categories',
    resource_type: 'auto', // handles both images and videos
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm'],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'category-' + uniqueSuffix;
    }
  },
});
 
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit for videos
  },
  fileFilter: (req, file, cb) => {
    // Accept images and videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed!'), false);
    }
  }
});
 
// Upload multiple files (image + video)
const uploadFiles = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'video', maxCount: 1 }
]);
 
// Middleware to handle multer upload
const handleUpload = (req, res, next) => {
  uploadFiles(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'File upload error', details: err.message });
    } else if (err) {
      return res.status(500).json({ error: 'File upload error', details: err.message });
    }
    next();
  });
};
 
// multer-storage-cloudinary already sets file.path to the full Cloudinary CDN URL,
// so no manual path-to-URL transform is needed anymore. Kept as a no-op pass-through
// in case other code still references this middleware name.
const transformPathsToUrls = (req, res, next) => {
  next();
};
 
// Public routes
router.get('/', categoryController.getAllCategories);
router.get('/nested', categoryController.getNestedCategories);
router.get('/:id', categoryController.getCategory);
 
// Admin routes - get all categories (including inactive)
router.get('/admin/all', authenticateToken, isAdmin, categoryController.getAllCategoriesAdmin);
 
// Protected admin routes with file upload
router.post('/', authenticateToken, isAdmin, handleUpload, transformPathsToUrls, categoryController.createCategory);
router.post('/upload', authenticateToken, isAdmin, handleUpload, transformPathsToUrls, categoryController.createCategory);
router.post('/update-order', authenticateToken, isAdmin, categoryController.updateCategoryOrder);
router.put('/:id', authenticateToken, isAdmin, handleUpload, transformPathsToUrls, categoryController.updateCategory);
router.put('/:id/upload', authenticateToken, isAdmin, handleUpload, transformPathsToUrls, categoryController.updateCategory);
router.delete('/:id', authenticateToken, isAdmin, categoryController.deleteCategory);
 
module.exports = router;