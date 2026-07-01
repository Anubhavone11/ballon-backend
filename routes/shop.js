const express = require("express");
const router = express.Router();
const multer = require("multer");
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const {
  getAllProducts,
  getProduct,
  createProductWithFiles,
  updateProductWithFiles,
  deleteProduct,
  getProductsBySection,
  updateProductSections
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
 
// Upload multiple images (main image + 9 additional images)
const uploadImages = upload.fields([
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
  uploadImages(req, res, function (err) {
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
 
// Get all products
router.get("/", getAllProducts);
 
// Get products by section
router.get("/section/:section", getProductsBySection);
 
// Get single product
router.get("/:id", getProduct);
 
// Upload images and create product
router.post("/upload", handleUpload, transformPathsToUrls, createProductWithFiles);
 
// Update product by id
router.put("/:id", handleUpload, transformPathsToUrls, updateProductWithFiles);
 
// Update product sections
router.patch("/:id/sections", updateProductSections);
 
// Delete product by id
router.delete("/:id", deleteProduct);
 
module.exports = router;
 