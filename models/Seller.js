const mongoose = require('mongoose');

const sellerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },

  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true
  },

  // ── OTP-based identity — this is what a seller logs in with ─────────────
  businessPhone: {
    type: String,
    required: [true, 'Business phone number is required'],
    unique: true,
    trim: true
  },

  // True once the seller has verified businessPhone via WhatsApp OTP.
  // (Separate from `verified`, which is your admin/KYC document check below.)
  phoneVerified: {
    type: Boolean,
    default: false
  },

  // ── OTP challenge state (never store the raw OTP) ───────────────────────
  otpHash: {
    type: String,
    default: null,
    select: false
  },

  otpExpiresAt: {
    type: Date,
    default: null,
    select: false
  },

  otpLastSentAt: {
    type: Date,
    default: null,
    select: false
  },

  otpAttempts: {
    type: Number,
    default: 0,
    select: false
  },

  emergencyPhone: {
    type: String,
    default: '',
    trim: true
  },

  // ── Location (manual entry, no map / lat-long) ──────────────────────────
  state: {
    type: String,
    required: [true, 'State is required'],
    trim: true
  },

  city: {
    type: String,
    required: [true, 'City is required'],
    trim: true
  },

  address: {
    type: String,
    required: [true, 'Full address is required'],
    trim: true
  },

  pincode: {
    type: String,
    required: [true, 'Pincode is required'],
    trim: true,
    match: [/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit pincode']
  },

  description: {
    type: String,
    default: ''
  },

  passportPhoto: {
    public_id: String,
    url: String,
    alt: {
      type: String,
      default: 'Passport Size Photo'
    }
  },

  isPremium: {
    type: Boolean,
    default: false
  },

  isOnline: {
    type: Boolean,
    default: true
  },

  isAllocated: {
    type: Boolean,
    default: false
  },

  rating: {
    type: Number,
    default: 5,
    min: 0,
    max: 5
  },

  totalRatings: {
    type: Number,
    default: 0
  },

  totalReviews: {
    type: Number,
    default: 0
  },

  // 📈 Bookings System Execution Counters
  completedBookings: {
    type: Number,
    default: 0
  },

  paidBookingsCount: {
    type: Number,
    default: 0
  },

  // 💰 Ledger Financial metrics
  totalPaymentsReceived: {
    type: Number,
    default: 0
  },

  // Admin-side KYC / document verification — distinct from phoneVerified above
  verified: {
    type: Boolean,
    default: false
  },

  approved: {
    type: Boolean,
    default: false
  },

  blocked: {
    type: Boolean,
    default: false
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Seller', sellerSchema);