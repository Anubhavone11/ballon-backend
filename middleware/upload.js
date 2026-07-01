const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
 
// Configure Cloudinary storage (replaces local diskStorage)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/uploads',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4'],
    resource_type: 'auto', // auto-detects image vs video
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'file-' + uniqueSuffix;
    }
  },
});
 
// Configure multer
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});
 
module.exports = upload;