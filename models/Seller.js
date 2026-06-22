const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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

  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6
  },

  businessPhone: {
    type: String,
    required: [true, 'Business phone number is required'],
    trim: true
  },

  emergencyPhone: {
    type: String,
    default: '',
    trim: true
  },

  address: {
    type: String,
    default: ''
  },

  city: {
    type: String,
    required: [true, 'City is required'],
    trim: true
  },

  state: {
    type: String,
    required: [true, 'State is required'],
    trim: true
  },

  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0] // [longitude, latitude]
    }
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
    default: 0 // ◄ Total orders they completed for customers
  },

  paidBookingsCount: {
    type: Number,
    default: 0 // ◄ Total orders they actually paid us for via the Admin panel
  },

  // 💰 Ledger Financial metrics
  totalPaymentsReceived: {
    type: Number,
    default: 0 // ◄ Total money amount they sent us
  },

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

sellerSchema.index({ location: '2dsphere' });

sellerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

sellerSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Seller', sellerSchema);