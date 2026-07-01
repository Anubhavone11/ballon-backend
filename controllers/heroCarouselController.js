const HeroCarousel = require('../models/heroCarousel');
const fsPromises = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
 
// Path to JSON file where carousel items are stored
const dataFilePath = path.join(__dirname, '../data/hero-carousel.json');
 
// Configure Cloudinary storage (replaces local diskStorage)
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'decoryy/hero-carousel',
    resource_type: 'auto', // handles both images and videos
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm'],
    public_id: (req, file) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      return 'carousel-' + uniqueSuffix;
    }
  },
});
 
// Configure multer
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
 
// Helper function to read carousel data
const readCarouselData = async () => {
  try {
    const data = await fsPromises.readFile(dataFilePath, 'utf8');
    return JSON.parse(data).carousel || [];
  } catch (error) {
    console.error('Error reading carousel data:', error);
    return [];
  }
};
 
// Helper function to write carousel data
const writeCarouselData = async (data) => {
  try {
    await fsPromises.writeFile(dataFilePath, JSON.stringify({ carousel: data }, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing carousel data:', error);
    return false;
  }
};
 
// Get all carousel items
const getAllCarouselItems = async (req, res) => {
  try {
    const items = await HeroCarousel.find().sort('order');
    res.json(items);
  } catch (error) {
    console.error('Error fetching carousel items:', error);
    res.status(500).json({ message: "Error fetching carousel items", error: error.message });
  }
};
 
// Get single carousel item
const getCarouselItem = async (req, res) => {
  try {
    const item = await HeroCarousel.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Carousel item not found" });
    }
    res.json(item);
  } catch (error) {
    console.error('Error fetching carousel item:', error);
    res.status(500).json({ message: "Error fetching carousel item", error: error.message });
  }
};
 
// Get active carousel items (with optional city filter)
const getActiveCarouselItems = async (req, res) => {
  try {
    const { city } = req.query;
    const query = { isActive: true };
 
    // If city provided, filter by city (with backward compatibility)
    if (city) {
      const City = require('../models/City');
      const mongoose = require('mongoose');
      let cityId = null;
 
      if (mongoose.Types.ObjectId.isValid(city)) {
        cityId = city;
      } else {
        // Try to find city by name
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        if (cityDoc) {
          cityId = cityDoc._id;
        }
      }
 
      if (cityId) {
        // Find ONLY carousel items that have this city in their cities array
        // No backward compatibility - only show explicitly assigned carousel items
        query.cities = cityId;
      }
    }
 
    const items = await HeroCarousel.find(query).sort('order');
    res.json(items);
  } catch (error) {
    console.error('Error fetching active carousel items:', error);
    res.status(500).json({ message: "Error fetching active carousel items", error: error.message });
  }
};
 
// Create carousel item with file upload
const createCarouselItemWithFiles = async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('=== Starting Hero Carousel Item Creation ===');
    console.log('File received:', req.file ? {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path
    } : 'No file');
    console.log('Body data:', req.body);
 
    // Require image
    if (!req.file) {
      return res.status(400).json({
        error: 'Image is required. Make sure you are uploading as multipart/form-data and the file field is named "image".'
      });
    }
    const file = req.file;
    const itemData = req.body;
 
    // Log file processing time
    const fileProcessingTime = Date.now() - startTime;
    console.log(`File processing took: ${fileProcessingTime}ms`);
 
    // Validate required fields
    const requiredFields = ["title"];
    const missingFields = [];
    for (const field of requiredFields) {
      if (!itemData[field]) {
        missingFields.push(field);
      }
    }
    if (missingFields.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
    }
 
    // multer-storage-cloudinary already gives us the hosted CDN URL on file.path
    const imageUrl = file.path || '';
 
    // Get current max order
    const maxOrderItem = await HeroCarousel.findOne().sort('-order');
    const newOrder = maxOrderItem ? maxOrderItem.order + 1 : 0;
    const newItem = new HeroCarousel({
      title: itemData.title.trim(),
      buttonText: (itemData.buttonText || 'Shop Now').trim(),
      buttonLink: (itemData.buttonLink || '/shop').trim(),
      image: imageUrl,
      isMobile: itemData.isMobile === 'true' || itemData.isMobile === true,
      isActive: itemData.isActive === 'true' || itemData.isActive === true,
      order: newOrder
    });
 
    console.log('Saving carousel item to database...');
    const dbStartTime = Date.now();
    const savedItem = await newItem.save();
    const dbTime = Date.now() - dbStartTime;
    console.log(`Database save took: ${dbTime}ms`);
    console.log('Carousel item saved successfully:', savedItem);
 
    const totalTime = Date.now() - startTime;
    console.log(`Total creation time: ${totalTime}ms`);
 
    res.status(201).json({
      message: "Carousel item created successfully",
      item: savedItem,
      uploadedFile: file,
      performance: {
        totalTime: `${totalTime}ms`,
        fileProcessing: `${fileProcessingTime}ms`,
        databaseSave: `${dbTime}ms`
      }
    });
  } catch (error) {
    console.error('=== Error creating carousel item ===');
    console.error('Error details:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      message: "Error creating carousel item",
      error: error.message,
      details: error.stack
    });
  }
};
 
// Update carousel item with file upload
const updateCarouselItemWithFiles = async (req, res) => {
  try {
    console.log('Updating carousel item with file:', req.file);
    console.log('Update data:', req.body);
 
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: "Carousel item ID is required" });
    }
 
    const file = req.file;
    const itemData = req.body;
 
    const existingItem = await HeroCarousel.findById(id);
    if (!existingItem) {
      return res.status(404).json({ message: "Carousel item not found" });
    }
 
    // Update logic — multer-storage-cloudinary gives us the hosted URL on file.path
    let imageUrl = existingItem.image;
    if (file) {
      imageUrl = file.path;
    }
    const updatedItem = {
      title: (itemData.title || existingItem.title).trim(),
      buttonText: (itemData.buttonText || existingItem.buttonText || 'Shop Now').trim(),
      buttonLink: (itemData.buttonLink || existingItem.buttonLink || '/shop').trim(),
      image: imageUrl,
      isMobile: typeof itemData.isMobile !== 'undefined' ? (itemData.isMobile === 'true' || itemData.isMobile === true) : existingItem.isMobile,
      isActive: typeof itemData.isActive !== 'undefined' ? (itemData.isActive === 'true' || itemData.isActive === true) : existingItem.isActive,
      order: typeof itemData.order !== 'undefined' ? itemData.order : existingItem.order
    };
 
    // Log the update operation
    console.log('Updating carousel item with data:', {
      id,
      imageUrl: imageUrl,
      fileReceived: file ? file.originalname : 'none'
    });
 
    const savedItem = await HeroCarousel.findByIdAndUpdate(id, updatedItem, { new: true });
 
    res.json({
      message: "Carousel item updated successfully",
      item: savedItem,
      uploadedFile: file
    });
  } catch (error) {
    console.error('Error updating carousel item:', error);
    res.status(500).json({ message: "Error updating carousel item", error: error.message });
  }
};
 
// Delete carousel item
const deleteCarouselItem = async (req, res) => {
  try {
    const item = await HeroCarousel.findByIdAndDelete(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Carousel item not found" });
    }
 
    // Reorder remaining items
    const remainingItems = await HeroCarousel.find().sort('order');
    for (let i = 0; i < remainingItems.length; i++) {
      await HeroCarousel.findByIdAndUpdate(remainingItems[i]._id, { order: i });
    }
 
    res.json({ message: "Carousel item deleted successfully" });
  } catch (error) {
    console.error('Error deleting carousel item:', error);
    res.status(500).json({ message: "Error deleting carousel item", error: error.message });
  }
};
 
// Toggle active status
const toggleCarouselActive = async (req, res) => {
  try {
    const item = await HeroCarousel.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Carousel item not found" });
    }
 
    item.isActive = !item.isActive;
    await item.save();
    res.json(item);
  } catch (error) {
    console.error('Error toggling carousel item status:', error);
    res.status(500).json({ message: "Error toggling carousel item status", error: error.message });
  }
};
 
// Update carousel items order
const updateCarouselOrder = async (req, res) => {
  try {
    const items = req.body;
    for (let i = 0; i < items.length; i++) {
      await HeroCarousel.findByIdAndUpdate(items[i]._id, { order: i });
    }
    res.json({ message: "Order updated successfully" });
  } catch (error) {
    console.error('Error updating carousel order:', error);
    res.status(500).json({ message: "Error updating carousel order", error: error.message });
  }
};
 
module.exports = {
  uploadMiddleware: upload.single('image'),
  getAllCarouselItems,
  getCarouselItem,
  getActiveCarouselItems,
  createCarouselItemWithFiles,
  updateCarouselItemWithFiles,
  deleteCarouselItem,
  toggleCarouselActive,
  updateCarouselOrder
};
 