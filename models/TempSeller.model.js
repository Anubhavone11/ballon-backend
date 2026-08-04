const mongoose = require('mongoose');

// Mirrors the customer-side TempUser pattern: holds a pending seller
// registration (all the form fields + an uploaded photo, if any) until the
// businessPhone is verified via WhatsApp OTP. Once verified, the controller
// promotes this into a real Seller document and deletes the temp record.
//
// For an existing seller just logging in, only { businessPhone, otp,
// otpExpires } get set/used — the rest stay empty.
const tempSellerSchema = new mongoose.Schema({
  businessPhone: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  otp: {
    type: String,
    required: true
  },

  otpExpires: {
    type: Date,
    required: true
  },

  // ── Pending registration data (only present for a brand-new seller) ────
  name: String,
  email: String,
  emergencyPhone: String,
  state: String,
  city: String,
  address: String,
  pincode: String,
  description: String,
  passportPhoto: {
    public_id: String,
    url: String
  },

  createdAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 // auto-delete abandoned temp docs after 1 hour
  }
});

module.exports = mongoose.model('TempSeller', tempSellerSchema);