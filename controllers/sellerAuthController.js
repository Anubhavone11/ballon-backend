const Seller = require('../models/Seller');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
// --- REGISTRATION CONTROLLER WITH FREE OPENSTREETMAP (NOMINATIM) ---
exports.register = async (req, res) => {
  try {
    const {
      businessName,
      email,
      password,
      phone,
      address,
      businessType,
      startingPrice,
      description,
      maxPersonsAllowed,
      amenity,
      totalHalls,
      enquiryDetails,
      bookingOpens,
      workingTimes,
      workingDates,
      foodType,
      roomsAvailable,
      bookingPolicy,
      additionalFeatures,
      deviceCoordinates // Captured directly from device sensors
    } = req.body;

    const normalizedEmail = email && email.toLowerCase().trim();
    if (!normalizedEmail) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const existingSeller = await Seller.findOne({ email: normalizedEmail });
    if (existingSeller) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const requiredFields = ['businessName', 'email', 'password'];
    const missingFields = requiredFields.filter(field => !req.body[field] || req.body[field].toString().trim() === '');
    if (missingFields.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missingFields.join(', ')}` });
    }

    // --- GEOLOCATION RESOLUTION CONTEXT ---
    let coordinates = [0, 0];

    // Priority 1: High-Accuracy Frontend Client GPS Coordinates
    if (deviceCoordinates) {
      try {
        const parsedCoords = typeof deviceCoordinates === 'string' ? JSON.parse(deviceCoordinates) : deviceCoordinates;
        if (Array.isArray(parsedCoords) && parsedCoords.length === 2) {
          coordinates = [parseFloat(parsedCoords[0]), parseFloat(parsedCoords[1])];
          console.log(`Using precise device tracking hardware vectors: [${coordinates}]`);
        }
      } catch (err) {
        console.error('Error handling device coordinates structure payload:', err.message);
      }
    }

    // Priority 2: Multi-Tier String Lookup Cascades via OpenStreetMap Nominatim
    if (coordinates[0] === 0 && address && address.trim() !== '') {
      try {
        // Pass 1: Try exact clean address
        const cleanAddress = address.replace(/(near|opposite|behind|beside|in front of)[^,]+/gi, '').trim();
        let encodedAddress = encodeURIComponent(cleanAddress);
        let url = `https://nominatim.openstreetmap.org/search?q=${encodedAddress}&format=json&limit=1`;
        
        let response = await axios.get(url, {
          headers: { 'User-Agent': 'CelebrationMarketplaceApp/1.0 (contact: your-email@example.com)' }
        });
        
        // Pass 2: Fallback extraction parsing for 6-Digit PIN Codes
        if (!response.data || response.data.length === 0) {
          const pinMatch = address.match(/\b\d{6}\b/);
          if (pinMatch) {
            url = `https://nominatim.openstreetmap.org/search?postalcode=${pinMatch[0]}&country=India&format=json&limit=1`;
            response = await axios.get(url, { headers: { 'User-Agent': 'CelebrationMarketplaceApp/1.0' } });
          }
        }

        // Pass 3: City Fallback Core Coordinates
        if (!response.data || response.data.length === 0) {
          const fallbackCity = req.body.location || "Arrah";
          url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(fallbackCity)}&country=India&format=json&limit=1`;
          response = await axios.get(url, { headers: { 'User-Agent': 'CelebrationMarketplaceApp/1.0' } });
        }

        if (response.data && response.data.length > 0) {
          const lat = parseFloat(response.data[0].lat);
          const lon = parseFloat(response.data[0].lon);
          coordinates = [lon, lat]; // GeoJSON index ordering format maps [longitude, latitude]
        }
      } catch (geoError) {
        console.error('OpenStreetMap fallback engines operation exception:', geoError.message);
      }
    }

    // Process uploaded images
    let images = [];
    if (req.files && req.files.length > 0) {
      images = req.files.map(file => ({
        public_id: file.filename,
        url: file.path,
        alt: 'Business image'
      }));
    }

    const processIncludedExcluded = (data) => {
      if (!data) return [];
      if (Array.isArray(data)) return data;
      return data.split(/[\n,]/).map(item => item.trim()).filter(item => item);
    };

    const processFaq = (data) => {
      if (!data) return [];
      if (Array.isArray(data)) return data;
      try {
        return JSON.parse(data);
      } catch (e) {
        return [];
      }
    };

    const seller = await Seller.create({
      businessName,
      email: normalizedEmail,
      password,
      phone,
      address,
      businessType,
      location: {
        type: 'Point',
        coordinates: coordinates
      },
      startingPrice,
      description,
      maxPersonsAllowed,
      amenity: amenity ? (Array.isArray(amenity) ? amenity : amenity.split(',').map(item => item.trim())) : [],
      totalHalls: totalHalls || 1,
      enquiryDetails,
      bookingOpens,
      workingTimes,
      workingDates,
      foodType: foodType ? (Array.isArray(foodType) ? foodType : foodType.split(',').map(item => item.trim())) : [],
      roomsAvailable: roomsAvailable || 1,
      bookingPolicy,
      additionalFeatures: additionalFeatures ? (Array.isArray(additionalFeatures) ? additionalFeatures : additionalFeatures.split(',').map(item => item.trim())) : [],
      included: processIncludedExcluded(req.body.included),
      excluded: processIncludedExcluded(req.body.excluded),
      faq: processFaq(req.body.faq),
      images
    });

    const token = jwt.sign(
      { id: seller._id, email: seller.email, businessName: seller.businessName, type: 'seller', isSeller: true },
      process.env.JWT_SECRET_SELLER || 'your-secret-key',
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      message: 'Seller registered successfully',
      token,
      seller: {
        id: seller._id,
        businessName: seller.businessName,
        email: seller.email,
        phone: seller.phone,
        address: seller.address,
        businessType: seller.businessType,
        location: seller.location, 
        startingPrice: seller.startingPrice,
        description: seller.description,
        maxPersonsAllowed: seller.maxPersonsAllowed,
        amenity: seller.amenity || [],
        totalHalls: seller.totalHalls || 1,
        enquiryDetails: seller.enquiryDetails || '',
        bookingOpens: seller.bookingOpens || '',
        workingTimes: seller.workingTimes || '',
        workingDates: seller.workingDates || '',
        foodType: seller.foodType || [],
        roomsAvailable: seller.roomsAvailable || 1,
        bookingPolicy: seller.bookingPolicy || '',
        additionalFeatures: seller.additionalFeatures || [],
        images: seller.images || [],
        profileImage: seller.profileImage || null,
        createdAt: seller.createdAt,
        verified: seller.verified,
        blocked: seller.blocked,
        approved: seller.approved
      }
    });
  } catch (error) {
    console.error('Seller registration error:', error);
    res.status(500).json({ success: false, message: 'Error registering seller' });
  }
};
// Get seller profile (JWT protected)
exports.getProfile = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller._id).select('-password');
    if (!seller) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }

    res.json({ success: true, seller });
  } catch (error) {
    console.error('Get seller profile error:', error);
    res.status(500).json({ success: false, message: 'Error fetching profile' });
  }
};
// Update seller profile (JWT protected)
exports.updateProfile = async (req, res) => {
  try {
    const updates = {
      businessName: req.body.businessName,
      phone: req.body.phone,
      address: req.body.address,
      businessType: req.body.businessType,
      location: req.body.location,
      startingPrice: req.body.startingPrice,
      description: req.body.description,
      maxPersonsAllowed: req.body.maxPersonsAllowed
    };

    // Handle array fields
    if (req.body.included !== undefined) {
      updates.included = Array.isArray(req.body.included) ? req.body.included : [];
    }
    if (req.body.excluded !== undefined) {
      updates.excluded = Array.isArray(req.body.excluded) ? req.body.excluded : [];
    }
    if (req.body.faq !== undefined) {
      updates.faq = Array.isArray(req.body.faq) ? req.body.faq : [];
    }

    const seller = await Seller.findByIdAndUpdate(
      req.seller._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password');

    if (!seller) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }

    res.json({ success: true, seller });
  } catch (error) {
    console.error('Update seller profile error:', error);
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
};
// Upload multiple images
exports.uploadImages = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No images uploaded'
      });
    }

    const images = req.files.map(file => ({
      public_id: file.filename,
      url: file.path,
      alt: 'Seller image'
    }));

    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { $push: { images: { $each: images } } },
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      success: true,
      message: 'Images uploaded successfully',
      images: seller.images
    });
  } catch (error) {
    console.error('Upload images error:', error);
    res.status(500).json({
      success: false,
      message: 'Error uploading images'
    });
  }
};

// Upload profile image
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No profile image uploaded'
      });
    }

    const profileImage = {
      public_id: req.file.filename,
      url: req.file.path,
      alt: 'Profile image'
    };

    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { profileImage },
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      success: true,
      message: 'Profile image uploaded successfully',
      profileImage: seller.profileImage
    });
  } catch (error) {
    console.error('Upload profile image error:', error);
    res.status(500).json({
      success: false,
      message: 'Error uploading profile image'
    });
  }
};

// Delete image
exports.deleteImage = async (req, res) => {
  try {
    const { imageId } = req.params;
    const fs = require('fs');
    const path = require('path');

    // Find the image in the seller's images array
    const seller = await Seller.findById(req.seller.id);
    const image = seller.images.id(imageId);

    if (!image) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }

    // Delete local file if it exists
    if (image.public_id) {
      // Assuming public_id stores the filename for local uploads
      const filePath = path.join(__dirname, '../data/seller-images', image.public_id);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error('Error deleting local file:', err);
        }
      }
    }

    // Remove from database
    seller.images.pull(imageId);
    await seller.save();

    res.json({
      success: true,
      message: 'Image deleted successfully'
    });
  } catch (error) {
    console.error('Delete image error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting image'
    });
  }
};

// Delete image (admin only)
exports.deleteImageAdmin = async (req, res) => {
  try {
    const { sellerId, imageId } = req.params;
    const fs = require('fs');
    const path = require('path');

    // Find the seller by ID
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    // Find the image in the seller's images array
    const image = seller.images.id(imageId);
    if (!image) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }

    // Delete local file if it exists
    if (image.public_id) {
      const filePath = path.join(__dirname, '../data/seller-images', image.public_id);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error('Error deleting local file:', err);
        }
      }
    }

    // Remove from database
    seller.images.pull(imageId);
    await seller.save();

    res.json({
      success: true,
      message: 'Image deleted successfully'
    });
  } catch (error) {
    console.error('Delete image error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting image'
    });
  }
};

// Delete profile image (admin only)
exports.deleteProfileImageAdmin = async (req, res) => {
  try {
    const { sellerId } = req.params;
    const fs = require('fs');
    const path = require('path');

    // Find the seller by ID
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    if (!seller.profileImage) {
      return res.status(404).json({
        success: false,
        message: 'Profile image not found'
      });
    }

    // Delete local file if it exists
    if (seller.profileImage.public_id) {
      const filePath = path.join(__dirname, '../data/seller-profiles', seller.profileImage.public_id);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error('Error deleting local file:', err);
        }
      }
    }

    // Remove from database
    seller.profileImage = null;
    await seller.save();

    res.json({
      success: true,
      message: 'Profile image deleted successfully'
    });
  } catch (error) {
    console.error('Delete profile image error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting profile image'
    });
  }
};
// Get all sellers (for admin panel)
exports.getAllSellers = async (req, res) => {
  try {
    console.log('=== GET ALL SELLERS REQUEST ===');
    console.log('Request headers:', req.headers);
    console.log('Request user:', req.user);

    const sellers = await Seller.find({}, '-password');
    console.log('Found sellers count:', sellers.length);


    console.log('=== SELLERS WITH WITHDRAWALS ===');
    sellers.forEach(seller => {
      console.log(`Seller: ${seller.businessName}`);

    });

    res.json({
      success: true,
      sellers: sellers
    });
  } catch (error) {
    console.error('Error fetching all sellers:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sellers',
      error: error.message
    });
  }
};

// Public method to get approved venues (no authentication required)
exports.getApprovedVenues = async (req, res) => {
  try {
    console.log('=== GET APPROVED VENUES REQUEST ===');

    const venues = await Seller.find(
      {
        approved: true,
        blocked: false
      },
      '-password -email -phone -address -description -amenity -totalHalls -enquiryDetails -bookingOpens -workingTimes -workingDates -foodType -roomsAvailable -bookingPolicy -additionalFeatures -createdAt -updatedAt -__v'
    );

    console.log('Found approved venues count:', venues.length);

    res.json({
      success: true,
      sellers: venues
    });
  } catch (error) {
    console.error('Error fetching approved venues:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching venues',
      error: error.message
    });
  }
};

// Update unique fields for existing sellers
exports.updateUniqueFields = async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const seller = await Seller.findOne({ email: normalizedEmail });
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    // Generate unique fields if they don't exist
    if (!seller.sellerToken || !seller.websiteLink) {

      const updatedSeller = await Seller.findByIdAndUpdate(
        seller._id,
        { sellerToken, websiteLink },
        { new: true }
      );

      res.json({
        success: true,
        message: 'Unique fields updated successfully',
        seller: updatedSeller
      });
    } else {
      res.json({
        success: true,
        message: 'Seller already has unique fields',
        seller
      });
    }
  } catch (error) {
    console.error('Update unique fields error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating unique fields'
    });
  }
};

// Test endpoint to list all sellers (for debugging)
exports.listAllSellers = async (req, res) => {
  try {
    const sellers = await Seller.find({}, 'email businessName createdAt');
    res.json({
      success: true,
      count: sellers.length,
      sellers: sellers.map(s => ({
        email: s.email,
        businessName: s.businessName,
        createdAt: s.createdAt
      }))
    });
  } catch (error) {
    console.error('List all sellers error:', error);
    res.status(500).json({
      success: false,
      message: 'Error listing sellers',
      error: error.message
    });
  }
};

// Test endpoint to verify seller controller is working
exports.test = async (req, res) => {
  try {
    // Test database connection
    const mongoose = require('mongoose');
    const dbState = mongoose.connection.readyState;
    const dbStates = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };

    res.json({
      success: true,
      message: 'Seller controller is working',
      database: dbStates[dbState] || 'unknown',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({
      success: false,
      message: 'Test endpoint error',
      error: error.message
    });
  }
};
// controllers/sellerAuthController.js



// --- ADD THIS NEW CONTROLLER FUNCTION ---
exports.getSellerById = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).select('-password');

    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    res.status(200).json({
      success: true,
      seller: seller
    });
  } catch (error) {
    console.error('Error fetching seller by ID:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
// Block or unblock a seller (admin only)
exports.setBlockedStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { blocked } = req.body;
    if (typeof blocked !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Blocked status must be boolean' });
    }
    const seller = await Seller.findByIdAndUpdate(id, { blocked }, { new: true });
    if (!seller) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }
    res.json({ success: true, message: `Seller ${blocked ? 'blocked' : 'unblocked'} successfully`, seller });
  } catch (error) {
    console.error('Set blocked status error:', error);
    res.status(500).json({ success: false, message: 'Error updating blocked status' });
  }
};

// Approve or disapprove a seller (admin only)
exports.setApprovalStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { approved } = req.body;
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Approval status must be boolean' });
    }
    const seller = await Seller.findByIdAndUpdate(id, { approved }, { new: true });
    if (!seller) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }
    res.json({ success: true, message: `Seller ${approved ? 'approved' : 'disapproved'} successfully`, seller });
  } catch (error) {
    console.error('Set approval status error:', error);
    res.status(500).json({ success: false, message: 'Error updating approval status' });
  }
};

// Delete a seller (admin only)
exports.deleteSeller = async (req, res) => {
  try {
    const { id } = req.params;
    const seller = await Seller.findByIdAndDelete(id);
    if (!seller) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }
    res.json({ success: true, message: 'Seller deleted successfully' });
  } catch (error) {
    console.error('Delete seller error:', error);
    res.status(500).json({ success: false, message: 'Error deleting seller' });
  }
};

// Update seller profile (admin only)
exports.updateSellerProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const mongoose = require('mongoose');

    // Check for valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid seller ID',
        error: `Cast to ObjectId failed for value "${id}"`
      });
    }

    // Process uploaded images
    let images = [];
    if (req.files && req.files.length > 0) {
      images = req.files.map(file => ({
        public_id: file.filename,
        url: file.path,
        alt: 'Business image'
      }));
    }

    // Process profile image if uploaded
    let profileImage = null;
    if (req.file) {
      profileImage = {
        public_id: req.file.filename,
        url: req.file.path,
        alt: 'Profile image'
      };
    }

    // Process array fields that come as arrays from frontend
    const processArrayField = (fieldName) => {
      if (req.body[`${fieldName}[]`]) {
        return Array.isArray(req.body[`${fieldName}[]`]) ? req.body[`${fieldName}[]`] : [req.body[`${fieldName}[]`]];
      }
      if (req.body[fieldName]) {
        return Array.isArray(req.body[fieldName]) ? req.body[fieldName] : [req.body[fieldName]];
      }
      return [];
    };

    // Process FAQ field - handle JSON string or array
    const processFaqField = () => {
      console.log('Processing FAQ field:', req.body.faq);
      console.log('FAQ type:', typeof req.body.faq);

      if (req.body.faq) {
        if (Array.isArray(req.body.faq)) {
          console.log('FAQ is array:', req.body.faq);
          return req.body.faq;
        }
        if (typeof req.body.faq === 'string') {
          try {
            const parsed = JSON.parse(req.body.faq);
            console.log('FAQ parsed from JSON:', parsed);
            return parsed;
          } catch (e) {
            console.error('Error parsing FAQ JSON:', e);
            console.error('FAQ string was:', req.body.faq);
            return [];
          }
        }
      }
      console.log('FAQ defaulting to empty array');
      return [];
    };

    const updates = {
      businessName: req.body.businessName,
      phone: req.body.phone,
      address: req.body.address,
      businessType: req.body.businessType,
      location: req.body.location,
      startingPrice: req.body.startingPrice,
      description: req.body.description,
      maxPersonsAllowed: req.body.maxPersonsAllowed,
      amenity: processArrayField('amenity'),
      totalHalls: req.body.totalHalls,
      enquiryDetails: req.body.enquiryDetails,
      bookingOpens: req.body.bookingOpens,
      workingTimes: req.body.workingTimes,
      workingDates: req.body.workingDates,
      foodType: processArrayField('foodType'),
      roomsAvailable: req.body.roomsAvailable,
      bookingPolicy: req.body.bookingPolicy,
      additionalFeatures: processArrayField('additionalFeatures'),
      included: processArrayField('included'),
      excluded: processArrayField('excluded'),
      faq: processFaqField(),
      verified: req.body.verified === 'true' || req.body.verified === true,
      approved: req.body.approved === 'true' || req.body.approved === true,
      blocked: req.body.blocked === 'true' || req.body.blocked === true
    };

    // Add images if uploaded
    if (images.length > 0) {
      updates.images = images;
    }

    // Add profile image if uploaded
    if (profileImage) {
      updates.profileImage = profileImage;
    }

    // Remove undefined values
    Object.keys(updates).forEach(key => {
      if (updates[key] === undefined) {
        delete updates[key];
      }
    });

    console.log('Updating seller with ID:', id);
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Updates object:', JSON.stringify(updates, null, 2));
    console.log('Files received:', req.files ? req.files.length : 0);
    console.log('Profile file received:', !!req.file);
    console.log('FAQ in updates:', updates.faq);

    const seller = await Seller.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password');

    if (!seller) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }

    res.json({ success: true, seller });
  } catch (error) {
    console.error('Update seller profile error:', error);
    console.error('Error details:', error.message);
    console.error('Validation errors:', error.errors);

    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: validationErrors
      });
    }

    res.status(500).json({ success: false, message: 'Error updating seller profile', error: error.message });
  }
};

// Increment seller views (public endpoint)
exports.incrementViews = async (req, res) => {
  try {
    const { id } = req.params;

    const seller = await Seller.findByIdAndUpdate(
      id,
      { $inc: { views: 1 } },
      { new: true }
    ).select('views businessName');

    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    res.json({
      success: true,
      message: 'View count updated successfully',
      views: seller.views,
      sellerName: seller.businessName
    });
  } catch (error) {
    console.error('Increment views error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating view count'
    });
  }
};
// Paste this right below exports.register in sellerAuthController.js
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const seller = await Seller.findOne({ email: normalizedEmail });
    if (!seller) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await seller.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: seller._id, email: seller.email, businessName: seller.businessName, type: 'seller', isSeller: true },
      process.env.JWT_SECRET_SELLER || 'your-secret-key',
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      seller
    });
  } catch (error) {
    console.error('Seller login error:', error);
    res.status(500).json({ success: false, message: 'Error logging in' });
  }
};

// --- FIXED UNIFIED EXPORTS OBJECT ---
module.exports = {
  register: Object.getOwnPropertyDescriptor(exports, 'register') ? exports.register : async (req, res) => {},
  getProfile: exports.getProfile,
  updateProfile: exports.updateProfile,
  uploadImages: exports.uploadImages,
  uploadProfileImage: exports.uploadProfileImage,
  deleteImage: exports.deleteImage,
  deleteImageAdmin: exports.deleteImageAdmin,
  deleteProfileImageAdmin: exports.deleteProfileImageAdmin,
  getAllSellers: exports.getAllSellers,
  getApprovedVenues: exports.getApprovedVenues,
  updateUniqueFields: exports.updateUniqueFields,
  listAllSellers: exports.listAllSellers,
  test: exports.test,
  getSellerById: exports.getSellerById,
  setBlockedStatus: exports.setBlockedStatus,
  setApprovalStatus: exports.setApprovalStatus,
  deleteSeller: exports.deleteSeller,
  updateSellerProfile: exports.updateSellerProfile,
  incrementViews: exports.incrementViews
};

// Map everything directly back to module.exports so Node doesn't lose references
Object.assign(module.exports, exports);