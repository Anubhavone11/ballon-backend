const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { isAdmin, authenticateToken } = require('../middleware/auth');
const {
  getAllVideos,
  getVideo,
  createVideo,
  updateVideo,
  deleteVideo,
  getVideosByCategory
} = require('../controllers/videoController');
 
// Configure Cloudinary storage for videos (replaces local diskStorage)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/videos',
    resource_type: 'video',
    allowed_formats: ['mp4', 'mov', 'webm', 'avi', 'mkv'],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'video-' + uniqueSuffix;
    }
  },
});
 
// Configure multer with file size limits
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 1000 * 1024 * 1024 // 1000MB limit for videos
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  }
});
 
// Public routes (no authentication required)
router.get('/', getAllVideos);
router.get('/category/:category', getVideosByCategory);
router.get('/:id', getVideo);
 
// Protected routes (admin authentication required)
router.post('/', authenticateToken, isAdmin, createVideo);
router.put('/:id', authenticateToken, isAdmin, updateVideo);
router.delete('/:id', authenticateToken, isAdmin, deleteVideo);
 
// Upload video route with error handling
router.post('/upload', authenticateToken, isAdmin, (req, res) => {
  upload.single('video')(req, res, (err) => {
    try {
      // Handle multer errors
      if (err instanceof multer.MulterError) {
        console.error('Multer error:', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 1000MB.' });
        }
        return res.status(400).json({ error: 'File upload error', details: err.message });
      } else if (err) {
        console.error('Upload error:', err);
        return res.status(500).json({ error: 'Upload failed', details: err.message });
      }
 
      // Check if file was uploaded
      if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
      }
 
      console.log('Video uploaded successfully:', req.file);
 
      // multer-storage-cloudinary already gives us the full hosted CDN URL on req.file.path
      const videoUrl = req.file.path;
 
      res.json({
        videoUrl: videoUrl,
        publicId: req.file.filename,
        size: req.file.size,
        originalName: req.file.originalname
      });
    } catch (error) {
      console.error('Error uploading video:', error);
      res.status(500).json({ error: 'Failed to upload video', details: error.message });
    }
  });
});
 
module.exports = router;