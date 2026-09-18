const mongoose = require('mongoose');

const pinCodeServiceFeeSchema = new mongoose.Schema({
  pinCode: {
    type: String,
    required: true,
    unique: true, // one fee per pin code
    trim: true,
    validate: {
      validator: function (v) {
        return /^\d{6}$/.test(v);
      },
      message: 'Pin code must be a 6-digit number'
    }
  },
  // null/empty = use the default service fee setting
  serviceFee: {
    type: Number,
    min: 0,
    default: null
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for faster lookups (pinCode already has a unique index)
pinCodeServiceFeeSchema.index({ isActive: 1 });

module.exports = mongoose.model('PinCodeServiceFee', pinCodeServiceFeeSchema);