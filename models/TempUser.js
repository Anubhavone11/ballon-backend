// models/TempUser.js
// Short-lived record used only to hold a pending OTP for a phone number
// (and, for brand-new signups, the name the person typed in) until it's
// verified and turned into a real User.
//
// NOTE: if you already have a TempUser model keyed by `email` for the old
// forgot-password flow, either add these fields to it, or keep this as a
// second model (e.g. `PhoneOtp`) — just make sure the routes below import
// whichever one you choose.

const mongoose = require('mongoose');

const tempUserSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true,
  },
  name: {
    type: String, // only needed the first time, for account creation
  },
  otp: {
    type: String,
    required: true,
  },
  otpExpires: {
    type: Date,
    required: true,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('TempUser', tempUserSchema);