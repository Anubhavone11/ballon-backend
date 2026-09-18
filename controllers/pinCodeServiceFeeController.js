const PinCodeServiceFee = require('../models/PinCodeServiceFee');
const Settings = require('../models/Settings');

const PIN_REGEX = /^\d{6}$/;

// Get all ACTIVE pin code service fees (public)
const getAllPinCodeServiceFees = async (req, res) => {
  try {
    const pinCodeFees = await PinCodeServiceFee.find({ isActive: true })
      .sort({ pinCode: 1 });

    res.status(200).json({
      success: true,
      pinCodeFees
    });
  } catch (error) {
    console.error('Error fetching pin code service fees:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pin code service fees',
      error: error.message
    });
  }
};

// Get service fee for a single pin code (exact match, falls back to default fee)
const getPinCodeServiceFee = async (req, res) => {
  try {
    const { pinCode } = req.params;

    if (!pinCode || !PIN_REGEX.test(pinCode)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 6-digit pin code is required'
      });
    }

    const pinCodeFee = await PinCodeServiceFee.findOne({
      isActive: true,
      pinCode
    });

    // Pin code has its own fee -> use it
    if (pinCodeFee && pinCodeFee.serviceFee !== null && pinCodeFee.serviceFee !== undefined) {
      return res.status(200).json({
        success: true,
        pinCodeFee,
        serviceFee: pinCodeFee.serviceFee
      });
    }

    // Pin code not found, or its fee is empty -> use default service fee
    const defaultSetting = await Settings.findOne({ key: 'default_service_fee' });
    const defaultFee = defaultSetting ? Number(defaultSetting.value) || 0 : 0;

    res.status(200).json({
      success: true,
      pinCodeFee: pinCodeFee || null,
      serviceFee: defaultFee,
      isDefault: true
    });
  } catch (error) {
    console.error('Error fetching pin code service fee:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pin code service fee',
      error: error.message
    });
  }
};

// Create new pin code service fee
const createPinCodeServiceFee = async (req, res) => {
  try {
    const { pinCode, serviceFee, description } = req.body;

    if (!pinCode) {
      return res.status(400).json({
        success: false,
        message: 'Pin code is required'
      });
    }

    if (!PIN_REGEX.test(String(pinCode))) {
      return res.status(400).json({
        success: false,
        message: 'Pin code must be exactly 6 digits'
      });
    }

    // Fee is optional: empty/null means "use the default service fee"
    const hasFee = serviceFee !== undefined && serviceFee !== null && serviceFee !== '';
    if (hasFee && (isNaN(Number(serviceFee)) || Number(serviceFee) < 0)) {
      return res.status(400).json({
        success: false,
        message: 'Service fee must be a non-negative number'
      });
    }

    // Only one fee per pin code
    const existing = await PinCodeServiceFee.findOne({ pinCode: String(pinCode) });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'This pin code already has a service fee'
      });
    }

    const pinCodeFee = new PinCodeServiceFee({
      pinCode: String(pinCode),
      serviceFee: hasFee ? Number(serviceFee) : null,
      description: description || ''
    });

    await pinCodeFee.save();

    res.status(201).json({
      success: true,
      message: 'Pin code service fee created successfully',
      pinCodeFee
    });
  } catch (error) {
    console.error('Error creating pin code service fee:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'This pin code already has a service fee'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to create pin code service fee',
      error: error.message
    });
  }
};

// Update pin code service fee
const updatePinCodeServiceFee = async (req, res) => {
  try {
    const { id } = req.params;
    const { pinCode, serviceFee, description, isActive } = req.body;

    const pinCodeFee = await PinCodeServiceFee.findById(id);
    if (!pinCodeFee) {
      return res.status(404).json({
        success: false,
        message: 'Pin code service fee not found'
      });
    }

    if (pinCode !== undefined) {
      if (!PIN_REGEX.test(String(pinCode))) {
        return res.status(400).json({
          success: false,
          message: 'Pin code must be exactly 6 digits'
        });
      }

      // Check duplicate (excluding current record)
      const duplicate = await PinCodeServiceFee.findOne({
        _id: { $ne: id },
        pinCode: String(pinCode)
      });

      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: 'This pin code already has a service fee'
        });
      }
    }

    const feeIsEmpty = serviceFee === null || serviceFee === '';
    if (serviceFee !== undefined && !feeIsEmpty && (isNaN(Number(serviceFee)) || Number(serviceFee) < 0)) {
      return res.status(400).json({
        success: false,
        message: 'Service fee must be a non-negative number'
      });
    }

    const updateData = {};
    if (pinCode !== undefined) updateData.pinCode = String(pinCode);
    if (serviceFee !== undefined) updateData.serviceFee = feeIsEmpty ? null : Number(serviceFee);
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedPinCodeFee = await PinCodeServiceFee.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: 'Pin code service fee updated successfully',
      pinCodeFee: updatedPinCodeFee
    });
  } catch (error) {
    console.error('Error updating pin code service fee:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'This pin code already has a service fee'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to update pin code service fee',
      error: error.message
    });
  }
};

// Delete pin code service fee
const deletePinCodeServiceFee = async (req, res) => {
  try {
    const { id } = req.params;

    const pinCodeFee = await PinCodeServiceFee.findByIdAndDelete(id);
    if (!pinCodeFee) {
      return res.status(404).json({
        success: false,
        message: 'Pin code service fee not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Pin code service fee deleted successfully',
      pinCodeFee
    });
  } catch (error) {
    console.error('Error deleting pin code service fee:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete pin code service fee',
      error: error.message
    });
  }
};

// Get all pin code service fees, including inactive (admin)
const getAllPinCodeServiceFeesAdmin = async (req, res) => {
  try {
    const pinCodeFees = await PinCodeServiceFee.find()
      .sort({ pinCode: 1 });

    res.status(200).json({
      success: true,
      pinCodeFees
    });
  } catch (error) {
    console.error('Error fetching pin code service fees:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pin code service fees',
      error: error.message
    });
  }
};

module.exports = {
  getAllPinCodeServiceFees,
  getPinCodeServiceFee,
  createPinCodeServiceFee,
  updatePinCodeServiceFee,
  deletePinCodeServiceFee,
  getAllPinCodeServiceFeesAdmin
};