const Seller = require('../models/Seller');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const Booking = require("../models/Booking");

// =========================================================================
// 1. SELLER REGISTRATION PIPELINE (WITH GEOLOCATION CASUISTRY)
// =========================================================================
exports.register = async (req, res) => {
  try {
    const {
      businessName, email, password, phone, address, businessType,
      startingPrice, description, maxPersonsAllowed, amenity, totalHalls,
      enquiryDetails, bookingOpens, workingTimes, workingDates, foodType,
      roomsAvailable, bookingPolicy, additionalFeatures, deviceCoordinates
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

    let coordinates = [0, 0];

    // Priority A: Precision Hardware GPS Signature Parsing
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

    // Priority B: Nominatim Fallback Matrix
    if (coordinates[0] === 0 && address && address.trim() !== '') {
      try {
        const cleanAddress = address.replace(/(near|opposite|behind|beside|in front of)[^,]+/gi, '').trim();
        let encodedAddress = encodeURIComponent(cleanAddress);
        let url = `https://nominatim.openstreetmap.org/search?q=${encodedAddress}&format=json&limit=1`;
        
        let response = await axios.get(url, {
          headers: { 'User-Agent': 'CelebrationMarketplaceApp/1.0' }
        });
        
        if (!response.data || response.data.length === 0) {
          const pinMatch = address.match(/\b\d{6}\b/);
          if (pinMatch) {
            url = `https://nominatim.openstreetmap.org/search?postalcode=${pinMatch[0]}&country=India&format=json&limit=1`;
            response = await axios.get(url, { headers: { 'User-Agent': 'CelebrationMarketplaceApp/1.0' } });
          }
        }

        if (!response.data || response.data.length === 0) {
          const fallbackCity = req.body.location || "Arrah";
          url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(fallbackCity)}&country=India&format=json&limit=1`;
          response = await axios.get(url, { headers: { 'User-Agent': 'CelebrationMarketplaceApp/1.0' } });
        }

        if (response.data && response.data.length > 0) {
          const lat = parseFloat(response.data[0].lat);
          const lon = parseFloat(response.data[0].lon);
          coordinates = [lon, lat]; 
        }
      } catch (geoError) {
        console.error('OpenStreetMap fallback engines operation exception:', geoError.message);
      }
    }

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
      try { return JSON.parse(data); } catch (e) { return []; }
    };

    const seller = await Seller.create({
      businessName,
      email: normalizedEmail,
      password,
      phone,
      address,
      businessType,
      location: { type: 'Point', coordinates: coordinates },
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
      seller
    });
  } catch (error) {
    console.error('Seller registration error:', error);
    res.status(500).json({ success: false, message: 'Error registering seller' });
  }
};

// =========================================================================
// 2. CORE AUTHENTICATION PROFILE HANDLERS (SELLER AUTH PROTECTED)
// =========================================================================
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
      maxPersonsAllowed: req.body.maxPersonsAllowed,
      isOnline: req.body.isOnline
    };

    if (req.body.included !== undefined) updates.included = Array.isArray(req.body.included) ? req.body.included : [];
    if (req.body.excluded !== undefined) updates.excluded = Array.isArray(req.body.excluded) ? req.body.excluded : [];
    if (req.body.faq !== undefined) updates.faq = Array.isArray(req.body.faq) ? req.body.faq : [];

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

// =========================================================================
// 3. IMAGE MEDIA STACK CONTROLLERS
// =========================================================================
exports.uploadImages = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No images uploaded' });
    }

    const images = req.files.map(file => ({
      public_id: file.filename,
      url: file.path,
      alt: 'Seller image'
    }));

    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { $push: { images: { $each: images } } },
      { new: true }
    ).select('-password');

    res.json({ success: true, message: 'Images uploaded successfully', images: seller.images });
  } catch (error) {
    console.error('Upload images error:', error);
    res.status(500).json({ success: false, message: 'Error uploading images' });
  }
};

exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No profile image uploaded' });
    }

    const profileImage = {
      public_id: req.file.filename,
      url: req.file.path,
      alt: 'Profile image'
    };

    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { profileImage },
      { new: true }
    ).select('-password');

    res.json({ success: true, message: 'Profile image uploaded successfully', profileImage: seller.profileImage });
  } catch (error) {
    console.error('Upload profile image error:', error);
    res.status(500).json({ success: false, message: 'Error uploading profile image' });
  }
};

exports.deleteImage = async (req, res) => {
  try {
    const { imageId } = req.params;
    const fs = require('fs'); const path = require('path');

    const seller = await Seller.findById(req.seller.id);
    const image = seller.images.id(imageId);

    if (!image) {
      return res.status(404).json({ success: false, message: 'Image not found' });
    }

    if (image.public_id) {
      const filePath = path.join(__dirname, '../data/seller-images', image.public_id);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (err) { console.error(err); }
      }
    }

    seller.images.pull(imageId);
    await seller.save();

    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting image' });
  }
};

// =========================================================================
// 4. ADMIN & COMPATIBILITY LAYER MANAGEMENT ENDPOINTS
// =========================================================================
exports.deleteImageAdmin = async (req, res) => {
  try {
    const { sellerId, imageId } = req.params;
    const fs = require('fs'); const path = require('path');
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ success: false, message: 'Seller not found' });
    const image = seller.images.id(imageId);
    if (!image) return res.status(404).json({ success: false, message: 'Image not found' });

    if (image.public_id) {
      const filePath = path.join(__dirname, '../data/seller-images', image.public_id);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    seller.images.pull(imageId);
    await seller.save();
    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

exports.deleteProfileImageAdmin = async (req, res) => {
  try {
    const { sellerId } = req.params;
    const fs = require('fs'); const path = require('path');
    const seller = await Seller.findById(sellerId);
    if (!seller || !seller.profileImage) return res.status(404).json({ success: false, message: 'Not found' });

    if (seller.profileImage.public_id) {
      const filePath = path.join(__dirname, '../data/seller-profiles', seller.profileImage.public_id);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    seller.profileImage = null;
    await seller.save();
    res.json({ success: true, message: 'Profile image wiped.' });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

exports.getAllSellers = async (req, res) => {
  try {
    const sellers = await Seller.find({}, '-password');
    res.json({ success: true, sellers });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getApprovedVenues = async (req, res) => {
  try {
    const venues = await Seller.find({ approved: true, blocked: false }, '-password -email -phone');
    res.json({ success: true, sellers: venues });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.updateUniqueFields = async (req, res) => {
  try {
    const { email } = req.query;
    const seller = await Seller.findOne({ email: email.toLowerCase().trim() });
    if (!seller) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, seller });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

exports.listAllSellers = async (req, res) => {
  try {
    const sellers = await Seller.find({}, 'email businessName');
    res.json({ success: true, count: sellers.length, sellers });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.test = async (req, res) => {
  res.json({ success: true, message: 'Seller controller operational cluster verified.' });
};

exports.getSellerById = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).select('-password');
    if (!seller) return res.status(404).json({ success: false, message: 'Not found' });
    res.status(200).json({ success: true, seller });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

exports.setBlockedStatus = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(req.params.id, { blocked: req.body.blocked }, { new: true });
    res.json({ success: true, seller });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

exports.setApprovalStatus = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(req.params.id, { approved: req.body.approved }, { new: true });
    res.json({ success: true, seller });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

/* Administrative complete update block overrides cascade */
exports.updateSellerProfile = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    res.json({ success: true, seller });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.deleteSeller = async (req, res) => {
  try {
    await Seller.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted' });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

exports.incrementViews = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true });
    res.json({ success: true, views: seller.views });
  } catch (error) { res.status(500).json({ success: false, message: 'Error' }); }
};

// =========================================================================
// 5. PRODUCTION MERCHANT AUTHORIZED PORTAL SIGN IN ENTRY 
// =========================================================================
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("reached login handler");

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const seller = await Seller.findOne({ email: email.toLowerCase().trim() });
    if (!seller || !(await seller.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: seller._id, email: seller.email, businessName: seller.businessName, type: 'seller', isSeller: true },
      process.env.JWT_SECRET_SELLER || 'your-secret-key',
      { expiresIn: '30d' }
    );

    return res.json({ success: true, message: 'Login successful', token, seller });
  } catch (error) {
    console.error('Seller login error:', error);
    return res.status(500).json({ success: false, message: 'Error logging in' });
  }
};

// =========================================================================
// 6. INTERACTIVE REVENUE PIPELINE & TASK WORKFLOW ALLOCATIONS
// =========================================================================
exports.getSellerAssignedBookings = async (req, res) => {
  try {
    const sellerId = req.seller.id;
    const bookings = await Booking.find({ sellerId }).populate("userId", "name email phone").sort({ createdAt: -1 });
    return res.json({ success: true, bookings });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch bookings." });
  }
};

exports.toggleAllocationStatus = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id);
    if (!seller) return res.status(404).json({ success: false, message: "Seller profile not found." });
  console.log("toggle");
    seller.isAllocated = !seller.isAllocated;
    await seller.save();

    return res.status(200).json({ 
      success: true, 
      message: `Store status changed to ${seller.isAllocated ? 'ENGAGED' : 'AVAILABLE'}.`,
      isAllocated: seller.isAllocated 
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to update allocation status." });
  }
};

// =========================================================================
// 7. COMPREHENSIVE REGISTRY REFERENCE SYNC OBJECT MAPPING
// =========================================================================
module.exports = {
  login: exports.login,
  register: exports.register,
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
  incrementViews: exports.incrementViews,
  getSellerAssignedBookings: exports.getSellerAssignedBookings,
  toggleAllocationStatus: exports.toggleAllocationStatus
};

Object.assign(module.exports, exports);