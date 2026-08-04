const Seller = require('../models/Seller');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Booking = require('../models/Booking');

const OTP_TTL_MS = 5 * 60 * 1000;      // OTP valid for 5 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 resend per 60s
const MAX_OTP_ATTEMPTS = 5;

const hashOtp = (otp, businessPhone) =>
  crypto.createHash('sha256').update(`${otp}:${businessPhone}`).digest('hex');

const generateOtp = () => String(crypto.randomInt(100000, 1000000)); // 6 digits

// TODO: wire this up to your actual WhatsApp/SMS provider (Gupshup, Twilio, etc).
// Logging is fine for local/dev but must be replaced before production.
const sendWhatsAppOtp = async (businessPhone, otp) => {
  console.log(`[OTP] Sending ${otp} to +91${businessPhone}`);
  return true;
};

const signSellerToken = (seller) =>
  jwt.sign(
    { id: seller._id, email: seller.email, name: seller.name, type: 'seller', isSeller: true },
    process.env.JWT_SECRET_SELLER || 'your-secret-key',
    { expiresIn: '30d' }
  );

// =========================================================================
// 1. OTP-BASED REGISTRATION PIPELINE
// =========================================================================

// Step A: collect registration details, create/refresh an unverified seller
// record, and dispatch an OTP to their WhatsApp number.
exports.sendOtp = async (req, res) => {
  try {
    const {
      name, email, businessPhone, emergencyPhone,
      state, city, address, pincode, description
    } = req.body;

    const normalizedEmail = email && email.toLowerCase().trim();
    const normalizedPhone = businessPhone && businessPhone.toString().trim();

    const requiredFields = { name, email: normalizedEmail, businessPhone: normalizedPhone, state, city, address, pincode };
    const missingFields = Object.entries(requiredFields)
      .filter(([, v]) => !v || v.toString().trim() === '')
      .map(([k]) => k);
    if (missingFields.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missingFields.join(', ')}` });
    }

    // Look up any existing account with this email or phone.
    const existing = await Seller.findOne({
      $or: [{ email: normalizedEmail }, { businessPhone: normalizedPhone }]
    }).select('+otpLastSentAt phoneVerified email businessPhone');

    if (existing && existing.phoneVerified) {
      const conflictField = existing.email === normalizedEmail ? 'Email' : 'Phone number';
      return res.status(400).json({ success: false, message: `${conflictField} already registered` });
    }

    if (existing && existing.otpLastSentAt && Date.now() - existing.otpLastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      const waitSecs = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - existing.otpLastSentAt.getTime())) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${waitSecs}s before requesting another OTP.` });
    }

    let passportPhoto;
    if (req.file) {
      passportPhoto = {
        public_id: req.file.filename,
        url: req.file.path,
        alt: 'Passport Size Photo'
      };
    }

    const otp = generateOtp();
    const otpHash = hashOtp(otp, normalizedPhone);
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

    const update = {
      name,
      email: normalizedEmail,
      businessPhone: normalizedPhone,
      emergencyPhone,
      state,
      city,
      address,
      pincode,
      description,
      otpHash,
      otpExpiresAt,
      otpLastSentAt: new Date(),
      otpAttempts: 0
    };
    if (passportPhoto) update.passportPhoto = passportPhoto;

    // Upsert: create the pending seller record, or refresh an existing
    // unverified one (e.g. they abandoned an earlier attempt).
    await Seller.findOneAndUpdate(
      { businessPhone: normalizedPhone },
      { $set: update, $setOnInsert: { phoneVerified: false } },
      { upsert: true, new: true, runValidators: true }
    );

    await sendWhatsAppOtp(normalizedPhone, otp);

    res.json({ success: true, message: 'OTP sent to your WhatsApp' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Email or phone number already registered' });
    }
    console.error('sendOtp error:', error);
    res.status(500).json({ success: false, message: 'Error sending OTP' });
  }
};

// Step B: verify the OTP and, on success, mark the seller verified and log them in.
exports.verifyOtp = async (req, res) => {
  try {
    const { businessPhone, otp } = req.body;
    if (!businessPhone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone number and OTP are required' });
    }
    const normalizedPhone = businessPhone.toString().trim();

    const seller = await Seller.findOne({ businessPhone: normalizedPhone })
      .select('+otpHash +otpExpiresAt +otpAttempts');

    if (!seller || !seller.otpHash) {
      return res.status(400).json({ success: false, message: 'No pending OTP for this number. Please request a new one.' });
    }

    if (seller.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new OTP.' });
    }

    if (!seller.otpExpiresAt || seller.otpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: 'OTP expired. Please request a new one.' });
    }

    const providedHash = hashOtp(otp.toString().trim(), normalizedPhone);
    if (providedHash !== seller.otpHash) {
      seller.otpAttempts += 1;
      await seller.save();
      return res.status(401).json({ success: false, message: 'Incorrect OTP' });
    }

    seller.phoneVerified = true;
    seller.otpHash = undefined;
    seller.otpExpiresAt = undefined;
    seller.otpAttempts = 0;
    await seller.save();

    const token = signSellerToken(seller);
    const sellerObj = seller.toObject();
    delete sellerObj.otpHash;
    delete sellerObj.otpExpiresAt;
    delete sellerObj.otpAttempts;
    delete sellerObj.otpLastSentAt;

    res.json({ success: true, message: 'Registration successful!', token, seller: sellerObj });
  } catch (error) {
    console.error('verifyOtp error:', error);
    res.status(500).json({ success: false, message: 'Error verifying OTP' });
  }
};

// Login re-uses the same OTP mechanism for an already-verified seller.
exports.sendLoginOtp = async (req, res) => {
  try {
    const { businessPhone } = req.body;
    if (!businessPhone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    const normalizedPhone = businessPhone.toString().trim();

    const seller = await Seller.findOne({ businessPhone: normalizedPhone }).select('+otpLastSentAt');
    if (!seller || !seller.phoneVerified) {
      return res.status(404).json({ success: false, isNewSeller: true, message: 'No verified account found for this number' });
    }

    if (seller.otpLastSentAt && Date.now() - seller.otpLastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      const waitSecs = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - seller.otpLastSentAt.getTime())) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${waitSecs}s before requesting another OTP.` });
    }

    const otp = generateOtp();
    seller.otpHash = hashOtp(otp, normalizedPhone);
    seller.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    seller.otpLastSentAt = new Date();
    seller.otpAttempts = 0;
    await seller.save();

    await sendWhatsAppOtp(normalizedPhone, otp);
    res.json({ success: true, message: 'OTP sent to your WhatsApp' });
  } catch (error) {
    console.error('sendLoginOtp error:', error);
    res.status(500).json({ success: false, message: 'Error sending OTP' });
  }
};

// =========================================================================
// 2. CORE PROFILE HANDLERS
// =========================================================================
exports.getProfile = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller._id);
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
      emergencyPhone: req.body.emergencyPhone,
      address: req.body.address,
      city: req.body.city,
      state: req.body.state,
      pincode: req.body.pincode,
      description: req.body.description,
      isOnline: req.body.isOnline
    };
    Object.keys(updates).forEach((k) => updates[k] === undefined && delete updates[k]);

    const seller = await Seller.findByIdAndUpdate(
      req.seller._id,
      { $set: updates },
      { new: true, runValidators: true }
    );

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

    const seller = await Seller.findByIdAndUpdate(req.seller._id, { passportPhoto }, { new: true });
    res.json({ success: true, message: 'Passport photo uploaded', passportPhoto: seller.passportPhoto });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Upload error' });
  }
};

// =========================================================================
// 4. BOOKINGS / ALLOCATION
// =========================================================================
exports.getSellerAssignedBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ sellerId: req.seller._id }).populate('userId', 'name email phone').sort({ createdAt: -1 });
    return res.json({ success: true, bookings });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch bookings.' });
  }
};

exports.toggleAllocationStatus = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller._id);
    if (!seller) return res.status(404).json({ success: false, message: 'Not found' });
    seller.isAllocated = !seller.isAllocated;
    await seller.save();
    return res.status(200).json({ success: true, isAllocated: seller.isAllocated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Toggle failure' });
  }
};

// =========================================================================
// 5. ADMIN / SUPPORT
// =========================================================================
exports.getAllSellers = async (req, res) => {
  try { const sellers = await Seller.find({}); res.json({ success: true, sellers }); } catch (e) { res.status(500).json({ success: false }); }
};

exports.getSellerById = async (req, res) => {
  try { const seller = await Seller.findById(req.params.id); res.json({ success: true, seller }); } catch (e) { res.status(500).json({ success: false }); }
};

exports.deleteSeller = async (req, res) => {
  try { await Seller.findByIdAndDelete(req.params.id); res.json({ success: true, message: 'Deleted' }); } catch (e) { res.status(500).json({ success: false }); }
};

exports.setApprovalStatus = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndUpdate(
      req.params.id,
      { approved: req.body.approved, verified: req.body.approved },
      { new: true }
    );
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
    );
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
    );
    if (!seller) return res.status(404).json({ success: false, message: 'Seller profile not found' });
    res.json({ success: true, seller });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error setting premium status' });
  }
};

exports.addManualPayment = async (req, res) => {
  try {
    const { paymentAmount } = req.body;
    const sellerId = req.params.id;

    if (!paymentAmount || isNaN(paymentAmount) || Number(paymentAmount) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid payment amount greater than 0.'
      });
    }

    const seller = await Seller.findByIdAndUpdate(
      sellerId,
      { $inc: { totalPaymentsReceived: Number(paymentAmount), paidBookingsCount: 1 } },
      { new: true }
    );

    if (!seller) {
      return res.status(404).json({ success: false, message: 'Vendor not found.' });
    }

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

exports.test = async (req, res) => {
  res.json({ success: true, message: 'Seller controller operational cluster verified.' });
};