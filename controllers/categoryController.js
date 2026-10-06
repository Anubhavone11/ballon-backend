const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');

/**
 * Purge Redis cache keys whenever category structures change
 */
const purgeRedisCategoryCache = async (req) => {
  try {
    const redis = req.app.get('redisClient');
    if (!redis || !redis.isReady) return;

    // Fetch keys for categories, subcategories, and affected product listings
    const [categoryKeys, subCategoryKeys, productKeys] = await Promise.all([
      redis.keys('cache:/api/categories*'),
      redis.keys('cache:/api/subcategories*'),
      redis.keys('cache:/api/products*')
    ]);

    const allKeys = [...new Set([...categoryKeys, ...subCategoryKeys, ...productKeys])];

    if (allKeys.length > 0) {
      await redis.del(allKeys);
      console.log(`[REDIS PURGED] Cleared ${allKeys.length} category/product cache key(s)`);
    }
  } catch (err) {
    console.error('[REDIS PURGE ERROR]', err.message);
  }
};

// Get all categories for admin (including inactive ones)
exports.getAllCategoriesAdmin = async (req, res) => {
  try {
    const { city } = req.query;
    const query = {};

    if (city) {
      const City = require('../models/City');
      const mongoose = require('mongoose');
      let cityId = null;

      if (mongoose.Types.ObjectId.isValid(city)) {
        cityId = city;
      } else {
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        if (cityDoc) {
          cityId = cityDoc._id;
        }
      }

      if (cityId) {
        query.cities = cityId;
      }
    }

    const categories = await Category.find(query).sort({ sortOrder: 1, name: 1 });
    res.json({ categories });
  } catch (error) {
    console.error('Error in getAllCategoriesAdmin:', error);
    res.status(500).json({ message: 'Error fetching categories' });
  }
};

// Get all categories (with optional city filter)
exports.getAllCategories = async (req, res) => {
  try {
    const { city } = req.query;
    const query = { isActive: true };

    if (city) {
      const City = require('../models/City');
      const mongoose = require('mongoose');
      let cityId = null;

      if (mongoose.Types.ObjectId.isValid(city)) {
        cityId = city;
      } else {
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        if (cityDoc) {
          cityId = cityDoc._id;
        }
      }

      if (cityId) {
        query.cities = cityId;
      }
    }

    const categories = await Category.find(query).sort({ sortOrder: 1, name: 1 });
    res.json({ categories });
  } catch (error) {
    console.error('Error in getAllCategories:', error);
    res.status(500).json({ message: 'Error fetching categories' });
  }
};

exports.getNestedCategories = async (req, res) => {
  try {
    const { city } = req.query;
    const mongoose = require('mongoose');

    let cityFilter = null;
    if (city) {
      const City = require('../models/City');
      if (mongoose.Types.ObjectId.isValid(city)) {
        cityFilter = city;
      } else {
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        if (cityDoc) {
          cityFilter = cityDoc._id;
        }
      }
    }

    const categoryQuery = { isActive: true };
    const subCategoryQuery = { isActive: true };
    const productQuery = { inStock: true, stock: { $gt: 0 } };

    if (cityFilter) {
      categoryQuery.cities = cityFilter;
      subCategoryQuery.cities = cityFilter;
      productQuery.cities = cityFilter;
    }

    const [categories, subCategories, products] = await Promise.all([
      Category.find(categoryQuery).sort({ sortOrder: 1 }).lean(),
      SubCategory.find(subCategoryQuery).sort({ sortOrder: 1 }).lean(),
      require('../models/Product').find(productQuery)
    ]);

    const subCategoryMap = {};
    for (const sub of subCategories) {
      const parentId = sub.parentCategory.toString();
      if (!subCategoryMap[parentId]) {
        subCategoryMap[parentId] = [];
      }
      subCategoryMap[parentId].push(sub);
    }

    const productCountMap = {};
    for (const product of products) {
      const catId = product.category?.toString();
      if (catId) {
        productCountMap[catId] = (productCountMap[catId] || 0) + 1;
      }
    }

    const nestedCategories = categories.map(category => ({
      ...category,
      subCategories: subCategoryMap[category._id.toString()] || [],
      productCount: productCountMap[category._id.toString()] || 0
    }));

    res.status(200).json(nestedCategories);

  } catch (error) {
    console.error('Error fetching nested categories:', error);
    res.status(500).json({ message: 'Error fetching nested category data.', error: error.message });
  }
};

// Get single category
exports.getCategory = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }
    res.json({ category });
  } catch (error) {
    console.error('Error in getCategory:', error);
    res.status(500).json({ message: 'Error fetching category' });
  }
};

// Create new category with file upload
exports.createCategory = async (req, res) => {
  try {
    console.log('[CATEGORY CREATE] Files received:', req.files);
    console.log('[CATEGORY CREATE] Body data:', req.body);

    if (!req.body.name || !req.body.description) {
      return res.status(400).json({ message: 'Name and description are required' });
    }

    const categoryData = req.body;
    let imageUrl = '';
    let videoUrl = '';

    if (req.files) {
      if (req.files.image && req.files.image[0]) {
        imageUrl = req.files.image[0].path;
        console.log('[CATEGORY CREATE] Image URL:', imageUrl);
      }

      if (req.files.video && req.files.video[0]) {
        videoUrl = req.files.video[0].path;
        console.log('[CATEGORY CREATE] Video URL:', videoUrl);
      }
    }

    const newCategory = new Category({
      name: categoryData.name,
      description: categoryData.description,
      image: imageUrl,
      video: videoUrl,
      sortOrder: parseInt(categoryData.sortOrder) || 0,
      isActive: categoryData.isActive !== 'false'
    });

    const savedCategory = await newCategory.save();
    console.log('[CATEGORY CREATE] Category saved successfully:', savedCategory._id.toString());

    // Purge Redis cache
    await purgeRedisCategoryCache(req);

    res.status(201).json({ 
      message: "Category created successfully", 
      category: savedCategory,
      uploadedFiles: req.files
    });
  } catch (error) {
    console.error('[CATEGORY CREATE ERROR]', error.message);
    res.status(500).json({ 
      message: "Error creating category", 
      error: error.message
    });
  }
};

// Update category with file upload
exports.updateCategory = async (req, res) => {
  try {
    console.log('[CATEGORY UPDATE] Updating category with files:', req.files);
    console.log('[CATEGORY UPDATE] Body data:', req.body);

    const id = req.params.id;
    const categoryData = req.body;

    const existingCategory = await Category.findById(id);
    if (!existingCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    let imageUrl = existingCategory.image;
    let videoUrl = existingCategory.video;

    if (req.files) {
      if (req.files.image && req.files.image[0]) {
        imageUrl = req.files.image[0].path;
        console.log('[CATEGORY UPDATE] Image URL:', imageUrl);
      }

      if (req.files.video && req.files.video[0]) {
        videoUrl = req.files.video[0].path;
        console.log('[CATEGORY UPDATE] Video URL:', videoUrl);
      }
    }

    const updatedCategory = {
      name: categoryData.name || existingCategory.name,
      description: categoryData.description || existingCategory.description,
      image: imageUrl,
      video: videoUrl,
      sortOrder: categoryData.sortOrder ? parseInt(categoryData.sortOrder) : existingCategory.sortOrder,
      isActive: categoryData.isActive !== undefined ? 
        (typeof categoryData.isActive === 'boolean' ? categoryData.isActive : categoryData.isActive === 'true') 
        : existingCategory.isActive
    };

    const savedCategory = await Category.findByIdAndUpdate(id, updatedCategory, { new: true });
    console.log('[CATEGORY UPDATE] Updated successfully:', savedCategory._id.toString());

    // Purge Redis cache
    await purgeRedisCategoryCache(req);

    res.json({ 
      message: "Category updated successfully", 
      category: savedCategory,
      uploadedFiles: req.files
    });
  } catch (error) {
    console.error('[CATEGORY UPDATE ERROR]', error.message);
    res.status(500).json({ message: "Error updating category", error: error.message });
  }
};

// Delete category
exports.deleteCategory = async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    console.log('[CATEGORY DELETE] Deleted category:', req.params.id);

    // Purge Redis cache
    await purgeRedisCategoryCache(req);

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error in deleteCategory:', error);
    res.status(500).json({ message: 'Error deleting category' });
  }
};

// Update category order (bulk update)
exports.updateCategoryOrder = async (req, res) => {
  try {
    const { updates } = req.body;

    if (!Array.isArray(updates)) {
      return res.status(400).json({ message: 'Updates must be an array' });
    }

    console.log('[CATEGORY ORDER] Updating order count:', updates.length);

    const updatePromises = updates.map(update => 
      Category.findByIdAndUpdate(
        update.id,
        { sortOrder: update.sortOrder },
        { new: true }
      )
    );

    await Promise.all(updatePromises);

    // Purge Redis cache
    await purgeRedisCategoryCache(req);

    res.json({ 
      message: 'Category order updated successfully',
      updatedCount: updates.length
    });
  } catch (error) {
    console.error('Error updating category order:', error);
    res.status(500).json({ message: 'Error updating category order', error: error.message });
  }
};