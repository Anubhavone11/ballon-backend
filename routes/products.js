const express = require("express");
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { isAdmin, authenticateToken } = require('../middleware/auth');
const {
  getAllProducts,
  getInstantProducts, // ⚡ ADDED: Dynamic Instant Filter Controller Method
  getSearchSuggestions,
  getProduct,
  createProductWithFiles,
  updateProductWithFiles,
  updateProductSections,
  deleteProduct,
  getProductsBySection
} = require('../controllers/productController');
 
// Configure Cloudinary storage (replaces local diskStorage)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'product-' + uniqueSuffix;
    }
  },
});
 
// Configure multer
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});
 
// Configure multiple file upload fields
const uploadFields = upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'image1', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'image3', maxCount: 1 },
  { name: 'image4', maxCount: 1 },
  { name: 'image5', maxCount: 1 },
  { name: 'image6', maxCount: 1 },
  { name: 'image7', maxCount: 1 },
  { name: 'image8', maxCount: 1 },
  { name: 'image9', maxCount: 1 }
]);
 
// Middleware to handle multer upload
const handleUpload = (req, res, next) => {
  uploadFields(req, res, function (err) {
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
router.get("/", getAllProducts);
router.get("/search/suggestions", getSearchSuggestions);
router.get("/section/:section", getProductsBySection);
 
// ⚡ NEW: Explicit scope route for getting instant availability products
// Placing this right above /:id prevents Express from misinterpreting "service" as a product ID
router.get("/service/instant", getInstantProducts);
 
router.get("/:id", getProduct);
 
// Admin routes
router.post("/", authenticateToken, isAdmin, handleUpload, transformPathsToUrls, createProductWithFiles);
router.put("/:id", authenticateToken, isAdmin, handleUpload, transformPathsToUrls, updateProductWithFiles);
router.patch("/:id/sections", authenticateToken, isAdmin, updateProductSections);
router.delete("/:id", authenticateToken, isAdmin, deleteProduct);
 
module.exports = router;