const Settings = require('../models/Settings');

// Check if Settings model is available
if (!Settings) {
  console.error('Settings model not found');
}

// Get all settings
const getAllSettings = async (req, res) => {
  try {
    const settings = await Settings.find().sort({ key: 1 });
    res.status(200).json({ success: true, settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch settings', error: error.message });
  }
};

// Get a specific setting by key
const getSettingByKey = async (req, res) => {
  try {
    const { key } = req.params;
    const setting = await Settings.findOne({ key });

    if (!setting) {
      return res.status(404).json({ success: false, message: 'Setting not found' });
    }

    res.status(200).json({ success: true, setting });
  } catch (error) {
    console.error('Error fetching setting:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch setting', error: error.message });
  }
};

// Create or update a setting
const upsertSetting = async (req, res) => {
  try {
    const { key, value, description } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: 'Key and value are required' });
    }

    // Convert value to number for numeric settings
    let processedValue = value;
    if (key === 'cod_upfront_amount') {
      // Allow 0 as a valid value
      processedValue = value === '' || value === null || value === undefined ? 39 : Number(value);
    }
    if (key === 'default_service_fee') {
      processedValue = value === '' || value === null ? 0 : Math.max(0, Number(value) || 0);
    }

    const setting = await Settings.findOneAndUpdate(
      { key },
      {
        value: processedValue,
        description: description || '',
        updatedAt: new Date()
      },
      {
        new: true,
        upsert: true,
        runValidators: true
      }
    );

    res.status(200).json({
      success: true,
      message: 'Setting saved successfully',
      setting
    });
  } catch (error) {
    console.error('Error saving setting:', error);
    res.status(500).json({ success: false, message: 'Failed to save setting', error: error.message });
  }
};

// Delete a setting
const deleteSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const setting = await Settings.findOneAndDelete({ key });

    if (!setting) {
      return res.status(404).json({ success: false, message: 'Setting not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Setting deleted successfully',
      setting
    });
  } catch (error) {
    console.error('Error deleting setting:', error);
    res.status(500).json({ success: false, message: 'Failed to delete setting', error: error.message });
  }
};

// Initialize default settings
const initializeDefaultSettings = async () => {
  try {
    const defaultSettings = [
      {
        key: 'cod_upfront_amount',
        value: 39,
        description: 'Upfront payment amount for Cash on Delivery orders (in rupees)'
      },
      {
        key: 'default_service_fee',
        value: 0,
        description: 'Default service fee for pin codes that do not have a specific fee (in rupees)'
      }
    ];

    for (const setting of defaultSettings) {
      const existingSetting = await Settings.findOne({ key: setting.key });
      if (!existingSetting) {
        await Settings.create(setting);
        console.log(`Default setting created: ${setting.key}`);
      }
    }
  } catch (error) {
    console.error('Error initializing default settings:', error);
  }
};

// Get COD upfront amount (public endpoint)
const getCodUpfrontAmount = async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'cod_upfront_amount' });
    let amount = 39; // Default to 39 if not found

    if (setting) {
      amount = (setting.value === '' || setting.value === null || setting.value === undefined) ? 39 : Number(setting.value);
    }

    res.status(200).json({
      success: true,
      amount: amount
    });
  } catch (error) {
    console.error('Error fetching COD upfront amount:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch COD upfront amount',
      amount: 39 // Fallback to default
    });
  }
};

module.exports = {
  getAllSettings,
  getSettingByKey,
  upsertSetting,
  deleteSetting,
  initializeDefaultSettings,
  getCodUpfrontAmount
};