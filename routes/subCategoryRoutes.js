const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); // 🛠️ Added mongoose for validation checks
const Category = require('../models/Category'); 
const SubCategory = require('../models/SubCategory'); 
const { handleSubCategoryImage } = require('../middleware/subCategoryUpload');

// POST - Add a new sub-category to a specific category
router.post('/:categoryId/subcategories', handleSubCategoryImage, async (req, res, next) => {
  try {
    const { categoryId } = req.params;
    const { name, description, video, isActive, sortOrder } = req.body;

    // 🛡️ ANTI-CRASH GATE: If categoryId is a plain text string instead of a Hex ID, pass control along
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return next();
    }

    const parentCategory = await Category.findById(categoryId);
    if (!parentCategory) {
      return res.status(404).json({ message: 'Parent category not found' });
    }

    let imageUrl = '';
    if (req.file) {
      imageUrl = req.file.path; 
    }

    const newSubCategory = new SubCategory({
      name,
      description,
      image: imageUrl,
      video,
      isActive,
      sortOrder,
      parentCategory: categoryId 
    });

    await newSubCategory.save();
    res.status(201).json(newSubCategory);
  } catch (error) {
    res.status(500).json({ message: 'Error adding sub-category', error: error.message });
  }
});


// GET - List all sub-categories of a specific category
router.get('/:categoryId/subcategories', async (req, res, next) => {
  try {
    const { categoryId } = req.params;

    // 🛡️ ANTI-CRASH GATE: If categoryId isn't a true hex ObjectId, skip this router entirely
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return next(); // Passes the request seamlessly down to your products / shop routers
    }

    const parentCategory = await Category.findById(categoryId);
    if (!parentCategory) {
      return res.status(404).json({ message: 'Parent category not found' });
    }

    const subCategories = await SubCategory.find({ parentCategory: categoryId });
    res.status(200).json(subCategories);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching sub-categories', error: error.message });
  }
});


// PUT - Update a specific sub-category by its ID
router.put('/subcategories/:subCategoryId', handleSubCategoryImage, async (req, res, next) => {
  try {
    const { subCategoryId } = req.params;
    const updates = { ...req.body };

    if (!mongoose.Types.ObjectId.isValid(subCategoryId)) {
      return next();
    }

    if (req.file) {
      updates.image = req.file.path; 
    }

    const updatedSubCategory = await SubCategory.findByIdAndUpdate(subCategoryId, updates, { new: true, runValidators: true });

    if (!updatedSubCategory) {
      return res.status(404).json({ message: 'Sub-category not found' });
    }

    res.status(200).json(updatedSubCategory);
  } catch (error) {
    res.status(500).json({ message: 'Error updating sub-category', error: error.message });
  }
});


// DELETE - Delete a specific sub-category by its ID
router.delete('/subcategories/:subCategoryId', async (req, res, next) => {
  try {
    const { subCategoryId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(subCategoryId)) {
      return next();
    }

    const deletedSubCategory = await SubCategory.findByIdAndDelete(subCategoryId);

    if (!deletedSubCategory) {
      return res.status(404).json({ message: 'Sub-category not found' });
    }

    res.status(200).json({ message: 'Sub-category deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting sub-category', error: error.message });
  }
});

module.exports = router;