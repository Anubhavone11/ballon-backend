// models/User.js

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  // Email is now OPTIONAL. Customers sign up via phone+OTP and may never
  // provide an email. Google users still get one from their profile.
  email: {
    type: String,
    required: false,
    unique: true,
    sparse: true, // allows many docs with no email without violating uniqueness
    lowercase: true,
  },
  // Password is optional/unused for customers now (OTP-only login).
  // Kept only for vendor accounts, which live on a separate model/collection
  // if that's how your Seller side is structured.
  password: {
    type: String,
    required: false,
  },
  // Field to store the user's unique Google ID / profile pic
  googleId: {
    type: String,
    unique: true,
    sparse: true,
  },
  profilePicture: {
    type: String,
    default: '',
  },
  // Phone is now the PRIMARY identifier for customer accounts.
  // Required + unique for any account created through the OTP flow.
  phone: {
    type: String,
    required: true,
    unique: true,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  address: {
    type: String,
    default: '',
  },
}, {
  timestamps: true,
});

// Hash password before saving (only relevant if a password ever exists,
// e.g. legacy accounts created before this migration)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password (kept for any legacy password-based accounts)
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);