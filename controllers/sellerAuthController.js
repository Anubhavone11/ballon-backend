const Seller = require('../models/Seller');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const Booking = require("../models/Booking");
const mongoose = require('mongoose');

// =========================================================================
// 1. SELLER REGISTRATION PIPELINE
// =========================================================================
exports.register = async (req, res) => {
  try {
    const {
      name, email, password, businessPhone, emergencyPhone, address, 
      city, state, description, deviceCoordinates
    } = req.body;

    const normalizedEmail = email && email.toLowerCase().trim();
    if (!normalizedEmail) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const existingSeller = await Seller.findOne({ email: normalizedEmail });
    if (existingSeller) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const requiredFields = ['name', 'email', 'password', 'businessPhone', 'city', 'state'];
    const missingFields = requiredFields.filter(field => !req.body[field] || req.body[field].toString().trim() === '');
    if (missingFields.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missingFields.join(', ')}` });
    }

    let coordinates = [0, 0];

    if (deviceCoordinates) {
      try {
        const parsedCoords = typeof deviceCoordinates === 'string' ? JSON.parse(deviceCoordinates) : deviceCoordinates;
        if (Array.isArray(parsedCoords) && parsedCoords.length === 2) {
          coordinates = [parseFloat(parsedCoords[0]), parseFloat(parsedCoords[1])];
        }
      } catch (err) {
        console.error('Coordinates parsing failed:', err.message);
      }
    }

    // Geolocation Fallback Search Mapped to Arrah
    if (coordinates[0] === 0) {
      try {
        const searchCity = city || "Arrah";
        const searchState = state || "Bihar";
        const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(searchCity)}&state=${encodeURIComponent(searchState)}&country=India&format=json&limit=1`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'DecoryyMerchantApp/1.0' } });
        
        if (response.data && response.data.length > 0) {
          coordinates = [parseFloat(response.data[0].lon), parseFloat(response.data[0].lat)]; 
        }
      } catch (geoError) {
        console.error('Geo fallback error:', geoError.message);
      }
    }

    let passportPhoto = null;
    if (req.file) {
      passportPhoto = {
        public_id: req.file.filename,
        url: req.file.path,
        alt: 'Passport Size Photo'
      };
    }

    const seller = await Seller.create({
      name,
      email: normalizedEmail,
      password,
      businessPhone,
      emergencyPhone,
      address,
      city,
      state,
      location: { type: 'Point', coordinates },
      description,
      passportPhoto
    });

    const token = jwt.sign(
      { id: seller._id, email: seller.email, name: seller.name, type: 'seller', isSeller: true },
      process.env.JWT_SECRET_SELLER || 'your-secret-key',
      { expiresIn: '30d' }
    );

    res.status(201).json({ success: true, message: 'Seller registered successfully', token, seller });
  } catch (error) {
    console.error('Seller registration error:', error);
    res.status(500).json({ success: false, message: 'Error registering seller' });
  }
};

// =========================================================================
// 2. CORE AUTHENTICATION PROFILE HANDLERS
// =========================================================================
exports.getProfile = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller._id).select('-password');
    if (!seller) return res.status(404).json({ success: false, message: 'Seller not found' });
    res.json({ success: true, seller });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching profile' });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const updates = {
      name: req.body.name,
      businessPhone: req.body.businessPhone,
      emergencyPhone: req.body.emergencyPhone,
      address: req.body.address,
      city: req.body.city,
      state: req.body.state,
      description: req.body.description,
      isOnline: req.body.isOnline
    };

    const seller = await Seller.findByIdAndUpdate(
      req.seller._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password');

    res.json({ success: true, seller });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
};

// =========================================================================
// 3. PASSPORT SIZE IMAGERY CONTROLLERS
// =========================================================================
exports.uploadPassportPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No passport photo uploaded' });

    const passportPhoto = {
      public_id: req.file.filename,
      url: req.file.path,
      alt: 'Passport Size Photo'
    };

    const seller = await Seller.findByIdAndUpdate(req.seller.id, { passportPhoto }, { new: true }).select('-password');
    res.json({ success: true, message: 'Passport photo uploaded', passportPhoto: seller.passportPhoto });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Upload error' });
  }
};

// =========================================================================
// 4. MANAGEMENT & LOGIN PIPELINES
// =========================================================================
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'All fields required' });

    const seller = await Seller.findOne({ email: email.toLowerCase().trim() });
    if (!seller || !(await seller.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: seller._id, email: seller.email, name: seller.name, type: 'seller', isSeller: true },
      process.env.JWT_SECRET_SELLER || 'your-secret-key',
      { expiresIn: '30d' }
    );

    return res.json({ success: true, message: 'Login successful', token, seller });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error logging in' });
  }
};

exports.getSellerAssignedBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ sellerId: req.seller.id }).populate("userId", "name email phone").sort({ createdAt: -1 });
    return res.json({ success: true, bookings });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch bookings." });
  }
};

exports.toggleAllocationStatus = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id);
    if (!seller) return res.status(404).json({ success: false, message: "Not found" });
    seller.isAllocated = !seller.isAllocated;
    await seller.save();
    return res.status(200).json({ success: true, isAllocated: seller.isAllocated });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Toggle failure" });
  }
};

// Basic support hooks mapping
exports.getAllSellers = async (req, res) => {
  try { const sellers = await Seller.find({}, '-password'); res.json({ success: true, sellers }); } catch (e) { res.status(500).json({ success: false }); }
};

exports.getSellerById = async (req, res) => {
  try { const seller = await Seller.findById(req.params.id).select('-password'); res.json({ success: true, seller }); } catch (e) { res.status(500).json({ success: false }); }
};

exports.deleteSeller = async (req, res) => {
  try { await Seller.findByIdAndDelete(req.params.id); res.json({ success: true, message: 'Deleted' }); } catch (e) { res.status(500).json({ success: false }); }
};

// =========================================================================
// 5. ADMINISTRATIVE STATE SWITCHES (NEW ADMIN INTERFACE METHODS)
// =========================================================================
exports.setApprovalStatus = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(
      req.params.id, 
      { approved: req.body.approved, verified: req.body.approved }, 
      { new: true }
    ).select('-password');
    
    if (!seller) return res.status(404).json({ success: false, message: 'Seller profile not found' });
    res.json({ success: true, seller });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error setting approval status' });
  }
};

exports.setBlockedStatus = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(
      req.params.id, 
      { blocked: req.body.blocked }, 
      { new: true }
    ).select('-password');
    
    if (!seller) return res.status(404).json({ success: false, message: 'Seller profile not found' });
    res.json({ success: true, seller });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error setting block status' });
  }
};

exports.updateSellerPremiumStatus = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(
      req.params.id, 
      { isPremium: req.body.isPremium }, 
      { new: true }
    ).select('-password');
    console.log("check");
    
    if (!seller) return res.status(404).json({ success: false, message: 'Seller profile not found' });
    res.json({ success: true, seller });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error setting premium status' });
  }
};

exports.test = async (req, res) => {
  res.json({ success: true, message: 'Seller controller operational cluster verified.' });
};
// Add this method inside controllers/sellerController.js
exports.addManualPayment = async (req, res) => {
  try {
    const { paymentAmount } = req.body;
    const sellerId = req.params.id;

    // Validate the input amount
    if (!paymentAmount || isNaN(paymentAmount) || Number(paymentAmount) <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please enter a valid payment amount greater than 0.' 
      });
    }

    // Increment both the total cash received and the paid bookings count counter
    const seller = await Seller.findByIdAndUpdate(
      sellerId,
      { 
        $inc: { 
          totalPaymentsReceived: Number(paymentAmount),
          paidBookingsCount: 1 
        } 
      },
      { new: true }
    ).select('-password');

    if (!seller) {
      return res.status(404).json({ success: false, message: 'Vendor not found.' });
    }

    // Check if their bypass status is cleared or if they still owe
    const unpaidBookings = (seller.completedBookings || 0) - (seller.paidBookingsCount || 0);

    res.json({ 
      success: true, 
      message: `Successfully added ₹${paymentAmount} to ${seller.name}'s account! Unpaid status dropped to ${unpaidBookings < 0 ? 0 : unpaidBookings}.`, 
      seller 
    });
  } catch (error) {
    console.error('Error adding manual payment:', error);
    res.status(500).json({ success: false, message: 'Server error updating payment metrics.' });
  }
};
// =========================================================================
// 6. MODULE EXPORTS MAP OBJECT
// =========================================================================
module.exports = {
  login: exports.login,
  register: exports.register,
  getProfile: exports.getProfile,
  updateProfile: exports.updateProfile,
  uploadPassportPhoto: exports.uploadPassportPhoto,
  getAllSellers: exports.getAllSellers,
  getSellerById: exports.getSellerById,
  deleteSeller: exports.deleteSeller,
  getSellerAssignedBookings: exports.getSellerAssignedBookings,
  toggleAllocationStatus: exports.toggleAllocationStatus,
  setApprovalStatus: exports.setApprovalStatus,
  setBlockedStatus: exports.setBlockedStatus,
  updateSellerPremiumStatus: exports.updateSellerPremiumStatus,
  test: exports.test,
  addManualPayment:exports.addManualPayment
};