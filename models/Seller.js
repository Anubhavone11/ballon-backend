const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const sellerSchema = new mongoose.Schema({
  businessName: {
    type: String,
    required: [true, 'Business name is required'],
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

  phone: {
    type: String,
    default: ''
  },

  address: {
    type: String,
    default: ''
  },

  businessType: {
    type: String,
    default: ''
  },

  // GeoJSON Location
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    }
  },

  description: {
    type: String,
    default: ''
  },

  startingPrice: {
    type: Number,
    default: 0
  },

  maxPersonsAllowed: {
    type: Number,
    default: 50
  },

  amenity: {
    type: [String],
    default: []
  },

  totalHalls: {
    type: Number,
    default: 1
  },

  enquiryDetails: {
    type: String,
    default: ''
  },

  bookingOpens: {
    type: String,
    default: ''
  },

  workingTimes: {
    type: String,
    default: ''
  },

  workingDates: {
    type: String,
    default: ''
  },

  foodType: {
    type: [String],
    default: []
  },

  roomsAvailable: {
    type: Number,
    default: 1
  },

  bookingPolicy: {
    type: String,
    default: ''
  },

  additionalFeatures: {
    type: [String],
    default: []
  },

  included: {
    type: [String],
    default: []
  },

  excluded: {
    type: [String],
    default: []
  },

  faq: [
    {
      question: String,
      answer: String
    }
  ],

  images: [
    {
      public_id: String,
      url: String,
      alt: {
        type: String,
        default: 'Seller Image'
      }
    }
  ],

  profileImage: {
    public_id: String,
    url: String,
    alt: {
      type: String,
      default: 'Profile Image'
    }
  },

  // Matchmaking System
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

  completedBookings: {
    type: Number,
    default: 0
  },

  views: {
    type: Number,
    default: 0
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

// GeoSpatial Index
sellerSchema.index({ location: '2dsphere' });

// Password Hashing
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

// Compare Password
sellerSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Seller', sellerSchema);