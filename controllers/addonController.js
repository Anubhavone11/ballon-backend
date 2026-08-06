// controllers/addonController.js
const Addon = require('../models/Addon');
const Product = require('../models/Product');

// Public — list all (used by admin table + storefront if you filter isActive client-side)
exports.getAllAddons = async (req, res) => {
  try {
    const addons = await Addon.find()
      .populate('products', 'name')
      .populate('categories', 'name')
      .sort({ sortOrder: 1, createdAt: -1 });

    res.json({ success: true, data: addons });
  } catch (error) {
    console.error('Error fetching add-ons:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch add-ons', error: error.message });
  }
};

// Public — single addon (edit form / detail)
exports.getAddonById = async (req, res) => {
  try {
    const addon = await Addon.findById(req.params.id)
      .populate('products', 'name')
      .populate('categories', 'name');

    if (!addon) {
      return res.status(404).json({ success: false, message: 'Add-on not found' });
    }

    res.json({ success: true, data: addon });
  } catch (error) {
    console.error('Error fetching add-on:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch add-on', error: error.message });
  }
};

// Protected — create
exports.createAddon = async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      image,
      appliesToAll,
      products,
      categories,
      maxQuantity,
      sortOrder
    } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ success: false, message: 'Name and price are required' });
    }

    const scopedToAll = appliesToAll === undefined ? true : Boolean(appliesToAll);

    const addon = await Addon.create({
      name,
      description,
      price,
      image,
      appliesToAll: scopedToAll,
      products: scopedToAll ? [] : (products || []),
      categories: scopedToAll ? [] : (categories || []),
      maxQuantity,
      sortOrder
    });

    res.status(201).json({ success: true, data: addon, message: 'Add-on created successfully' });
  } catch (error) {
    console.error('Error creating add-on:', error);
    res.status(500).json({ success: false, message: 'Failed to create add-on', error: error.message });
  }
};

// Protected — update
exports.updateAddon = async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      image,
      appliesToAll,
      products,
      categories,
      maxQuantity,
      sortOrder
    } = req.body;

    const scopedToAll = appliesToAll === undefined ? true : Boolean(appliesToAll);

    const addon = await Addon.findByIdAndUpdate(
      req.params.id,
      {
        name,
        description,
        price,
        image,
        appliesToAll: scopedToAll,
        products: scopedToAll ? [] : (products || []),
        categories: scopedToAll ? [] : (categories || []),
        maxQuantity,
        sortOrder
      },
      { new: true, runValidators: true }
    );

    if (!addon) {
      return res.status(404).json({ success: false, message: 'Add-on not found' });
    }

    res.json({ success: true, data: addon, message: 'Add-on updated successfully' });
  } catch (error) {
    console.error('Error updating add-on:', error);
    res.status(500).json({ success: false, message: 'Failed to update add-on', error: error.message });
  }
};

// Protected — delete
exports.deleteAddon = async (req, res) => {
  try {
    const addon = await Addon.findByIdAndDelete(req.params.id);
    if (!addon) {
      return res.status(404).json({ success: false, message: 'Add-on not found' });
    }
    res.json({ success: true, message: 'Add-on deleted successfully' });
  } catch (error) {
    console.error('Error deleting add-on:', error);
    res.status(500).json({ success: false, message: 'Failed to delete add-on', error: error.message });
  }
};

// Protected — toggle active/inactive
exports.toggleAddonStatus = async (req, res) => {
  try {
    const addon = await Addon.findById(req.params.id);
    if (!addon) {
      return res.status(404).json({ success: false, message: 'Add-on not found' });
    }

    addon.isActive = !addon.isActive;
    await addon.save();

    res.json({
      success: true,
      data: addon,
      message: `Add-on ${addon.isActive ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Error toggling status:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle status', error: error.message });
  }
};

// Public — add-ons applicable to a specific product (storefront / checkout)
exports.getAddonsForProduct = async (req, res) => {
  try {
    const { productId } = req.params;

    const product = await Product.findById(productId).select('category');
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const addons = await Addon.find({
      isActive: true,
      $or: [
        { appliesToAll: true },
        { products: productId },
        { categories: product.category }
      ]
    }).sort({ sortOrder: 1 });

    res.json({ success: true, data: addons });
  } catch (error) {
    console.error('Error fetching add-ons for product:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch add-ons', error: error.message });
  }
};