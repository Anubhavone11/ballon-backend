const City = require('../models/City');
const Product = require('../models/Product');
const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const HeroCarousel = require('../models/heroCarousel');
const mongoose = require('mongoose');

/**
 * Helper to purge Redis keys affected by city changes
 * @param {Object} req - Express request object containing app reference
 * @param {boolean} purgeContent - Also purge products, categories, carousels (default: true)
 */
const purgeRedisCityCache = async (req, purgeContent = true) => {
  try {
    const redis = req.app.get('redisClient');
    if (!redis || !redis.isReady) return;

    const patterns = ['cache:/api/cities*'];

    if (purgeContent) {
      patterns.push(
        'cache:/api/products*',
        'cache:/api/shop*',
        'cache:/api/categories*',
        'cache:/api/subcategories*',
        'cache:/api/hero-carousel*',
        'cache:/api/bestseller*',
        'cache:/api/featured-products*'
      );
    }

    const keyArrays = await Promise.all(patterns.map(p => redis.keys(p)));
    const allKeys = [...new Set(keyArrays.flat())];

    if (allKeys.length > 0) {
      await redis.del(allKeys);
      console.log(`[REDIS PURGED] Cleared ${allKeys.length} city/related cache key(s)`);
    }
  } catch (err) {
    console.error('[REDIS PURGE ERROR]', err.message);
  }
};

exports.getCities = async (req, res) => {
  try {
    const showAll = req.query.showAll === 'true';
    const query = showAll ? {} : { isActive: { $ne: false } };
    const cities = await City.find(query).sort({ name: 1 });

    const citiesWithCount = await Promise.all(cities.map(async (city) => {
      const productCount = await Product.countDocuments({ cities: city._id });
      return {
        ...city.toObject(),
        productCount
      };
    }));

    res.json({ cities: citiesWithCount });
  } catch (err) {
    console.error('[GET CITIES ERROR]', err.message);
    res.status(500).json({ error: 'Failed to fetch cities' });
  }
};

exports.addCity = async (req, res) => {
  try {
    const { name, state, contactNumber } = req.body;
    const city = new City({ name, state, contactNumber });
    await city.save();

    await purgeRedisCityCache(req, false);

    res.status(201).json({ city });
  } catch (err) {
    console.error('[ADD CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to add city' });
  }
};

exports.deleteCity = async (req, res) => {
  try {
    await City.findByIdAndDelete(req.params.id);

    await purgeRedisCityCache(req, true);

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to delete city' });
  }
};

exports.updateCity = async (req, res) => {
  try {
    const { name, state, isActive, contactNumber } = req.body;
    const updateData = { name, state };
    if (isActive !== undefined) {
      updateData.isActive = isActive;
    }
    if (contactNumber !== undefined) {
      updateData.contactNumber = contactNumber;
    }

    const city = await City.findByIdAndUpdate(req.params.id, updateData, { new: true });

    await purgeRedisCityCache(req, true);

    res.json({ city });
  } catch (err) {
    console.error('[UPDATE CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to update city' });
  }
};

exports.toggleCityStatus = async (req, res) => {
  try {
    const city = await City.findById(req.params.id);
    if (!city) {
      return res.status(404).json({ error: 'City not found' });
    }

    city.isActive = !city.isActive;
    await city.save();

    await purgeRedisCityCache(req, true);

    res.json({ city, message: `City ${city.isActive ? 'activated' : 'deactivated'} successfully` });
  } catch (err) {
    console.error('[TOGGLE CITY STATUS ERROR]', err.message);
    res.status(400).json({ error: 'Failed to toggle city status' });
  }
};

exports.getCityProducts = async (req, res) => {
  try {
    const cityId = req.params.id;
    const activeCategories = await Category.find({ isActive: true }).select('_id');
    const activeCategoryIds = activeCategories.map(cat => cat._id);

    let products = await Product.find({
      $or: [
        { 'cityPrices.city': cityId },
        { cities: cityId }
      ],
      category: { $in: activeCategoryIds }
    })
      .populate('category', 'name')
      .populate('subCategory', 'name')
      .populate('cities', 'name')
      .sort({ date: -1 });

    products = products.map(product => {
      const cityPrice = product.cityPrices.find(cp => cp.city.toString() === cityId);
      const prodObj = product.toObject();

      if (cityPrice) {
        prodObj.price = cityPrice.price;
        prodObj.regularPrice = cityPrice.regularPrice;
      }

      return prodObj;
    });

    res.json({ products });
  } catch (err) {
    console.error('[GET CITY PRODUCTS ERROR]', err.message);
    res.status(500).json({ error: 'Failed to fetch city products' });
  }
};

exports.addProductsToCity = async (req, res) => {
  try {
    const { productIds, products: productData } = req.body;
    const cityId = req.params.id;

    const itemsToProcess = [];
    if (productData && Array.isArray(productData)) {
      itemsToProcess.push(...productData);
    } else if (productIds && Array.isArray(productIds)) {
      const productsList = await Product.find({ _id: { $in: productIds } });
      productsList.forEach(p => {
        itemsToProcess.push({
          productId: p._id,
          price: p.price,
          regularPrice: p.regularPrice
        });
      });
    }

    for (const item of itemsToProcess) {
      const productId = item.productId || item.id;
      const product = await Product.findById(productId);

      if (product) {
        if (!product.cities.includes(cityId)) {
          product.cities.push(cityId);
        }

        const existingPriceIndex = product.cityPrices.findIndex(
          cp => cp.city.toString() === cityId.toString()
        );

        if (existingPriceIndex > -1) {
          product.cityPrices[existingPriceIndex].price = item.price;
          product.cityPrices[existingPriceIndex].regularPrice = item.regularPrice;
        } else {
          product.cityPrices.push({
            city: cityId,
            price: item.price,
            regularPrice: item.regularPrice
          });
        }

        await product.save();
      }
    }

    await purgeRedisCityCache(req, true);

    res.json({ success: true, message: 'Products integrated with city pricing' });
  } catch (err) {
    console.error('[ADD PRODUCTS TO CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to add products to city' });
  }
};

exports.removeProductsFromCity = async (req, res) => {
  try {
    const { productIds } = req.body;
    const cityId = req.params.id;

    await Product.updateMany(
      { _id: { $in: productIds } },
      {
        $pull: {
          cities: cityId,
          cityPrices: { city: cityId }
        }
      }
    );

    await purgeRedisCityCache(req, true);

    res.json({ success: true, message: 'Products removed from city' });
  } catch (err) {
    console.error('[REMOVE PRODUCTS FROM CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to remove products from city' });
  }
};

exports.importProductsFromCity = async (req, res) => {
  try {
    const { sourceCityId } = req.body;
    const targetCityId = req.params.id;

    const sourceProducts = await Product.find({ cities: sourceCityId });

    const updatePromises = sourceProducts.map(product => {
      const sourcePriceEntry = product.cityPrices.find(cp => cp.city.toString() === sourceCityId);
      const price = sourcePriceEntry ? sourcePriceEntry.price : product.price;
      const regularPrice = sourcePriceEntry ? sourcePriceEntry.regularPrice : product.regularPrice;

      return Product.findByIdAndUpdate(product._id, {
        $addToSet: {
          cities: targetCityId,
          cityPrices: {
            city: targetCityId,
            price: price,
            regularPrice: regularPrice
          }
        }
      });
    });

    await Promise.all(updatePromises);
    await purgeRedisCityCache(req, true);

    res.json({
      success: true,
      message: `Imported ${sourceProducts.length} products from source city`,
      count: sourceProducts.length
    });
  } catch (err) {
    console.error('[IMPORT PRODUCTS ERROR]', err.message);
    res.status(400).json({ error: 'Failed to import products' });
  }
};

exports.getCityCategories = async (req, res) => {
  try {
    const categories = await Category.find({ cities: req.params.id })
      .sort({ sortOrder: 1, name: 1 });
    res.json({ categories });
  } catch (err) {
    console.error('[GET CITY CATEGORIES ERROR]', err.message);
    res.status(500).json({ error: 'Failed to fetch city categories' });
  }
};

exports.addCategoriesToCity = async (req, res) => {
  try {
    const { categoryIds } = req.body;
    const cityId = req.params.id;

    await Category.updateMany(
      { _id: { $in: categoryIds } },
      { $addToSet: { cities: cityId } }
    );

    const subcategories = await SubCategory.find({
      parentCategory: { $in: categoryIds }
    });

    if (subcategories.length > 0) {
      const subCategoryIds = subcategories.map(sc => sc._id);
      await SubCategory.updateMany(
        { _id: { $in: subCategoryIds } },
        { $addToSet: { cities: cityId } }
      );
    }

    await purgeRedisCityCache(req, true);

    res.json({
      success: true,
      message: `Categories added to city (${subcategories.length} subcategories auto-imported)`,
      categoriesAdded: categoryIds.length,
      subCategoriesAdded: subcategories.length
    });
  } catch (err) {
    console.error('[ADD CATEGORIES TO CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to add categories to city' });
  }
};

exports.removeCategoriesFromCity = async (req, res) => {
  try {
    const { categoryIds } = req.body;
    const cityId = req.params.id;

    await Category.updateMany(
      { _id: { $in: categoryIds } },
      { $pull: { cities: cityId } }
    );

    const subcategories = await SubCategory.find({
      parentCategory: { $in: categoryIds }
    });

    if (subcategories.length > 0) {
      const subCategoryIds = subcategories.map(sc => sc._id);
      await SubCategory.updateMany(
        { _id: { $in: subCategoryIds } },
        { $pull: { cities: cityId } }
      );
    }

    await purgeRedisCityCache(req, true);

    res.json({
      success: true,
      message: `Categories removed from city (${subcategories.length} subcategories auto-removed)`,
      categoriesRemoved: categoryIds.length,
      subCategoriesRemoved: subcategories.length
    });
  } catch (err) {
    console.error('[REMOVE CATEGORIES FROM CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to remove categories from city' });
  }
};

exports.getCitySubCategories = async (req, res) => {
  try {
    const subcategories = await SubCategory.find({ cities: req.params.id })
      .populate('parentCategory', 'name')
      .sort({ name: 1 });
    res.json({ subcategories });
  } catch (err) {
    console.error('[GET CITY SUBCATEGORIES ERROR]', err.message);
    res.status(500).json({ error: 'Failed to fetch city subcategories' });
  }
};

exports.addSubCategoriesToCity = async (req, res) => {
  try {
    const { subCategoryIds } = req.body;
    const cityId = req.params.id;

    await SubCategory.updateMany(
      { _id: { $in: subCategoryIds } },
      { $addToSet: { cities: cityId } }
    );

    await purgeRedisCityCache(req, true);

    res.json({ success: true, message: 'Subcategories added to city' });
  } catch (err) {
    console.error('[ADD SUBCATEGORIES TO CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to add subcategories to city' });
  }
};

exports.removeSubCategoriesFromCity = async (req, res) => {
  try {
    const { subCategoryIds } = req.body;
    const cityId = req.params.id;

    await SubCategory.updateMany(
      { _id: { $in: subCategoryIds } },
      { $pull: { cities: cityId } }
    );

    await purgeRedisCityCache(req, true);

    res.json({ success: true, message: 'Subcategories removed from city' });
  } catch (err) {
    console.error('[REMOVE SUBCATEGORIES FROM CITY ERROR]', err.message);
    res.status(400).json({ error: 'Failed to remove subcategories from city' });
  }
};

exports.getCityCarouselItems = async (req, res) => {
  try {
    const carouselItems = await HeroCarousel.find({ cities: req.params.id })
      .sort({ sortOrder: 1, createdAt: -1 });
    res.json({ carouselItems });
  } catch (err) {
    console.error('[GET CITY CAROUSEL ERROR]', err.message);
    res.status(500).json({ error: 'Failed to fetch city carousel items' });
  }
};

exports.addCarouselItemsToCity = async (req, res) => {
  try {
    const { itemIds } = req.body;
    const cityId = req.params.id;

    await HeroCarousel.updateMany(
      { _id: { $in: itemIds } },
      { $addToSet: { cities: cityId } }
    );

    await purgeRedisCityCache(req, true);

    res.json({ success: true, message: 'Carousel items added to city' });
  } catch (err) {
    console.error('[ADD CAROUSEL ITEMS ERROR]', err.message);
    res.status(400).json({ error: 'Failed to add carousel items to city' });
  }
};

exports.removeCarouselItemsFromCity = async (req, res) => {
  try {
    const { itemIds } = req.body;
    const cityId = req.params.id;

    await HeroCarousel.updateMany(
      { _id: { $in: itemIds } },
      { $pull: { cities: cityId } }
    );

    await purgeRedisCityCache(req, true);

    res.json({ success: true, message: 'Carousel items removed from city' });
  } catch (err) {
    console.error('[REMOVE CAROUSEL ITEMS ERROR]', err.message);
    res.status(400).json({ error: 'Failed to remove carousel items from city' });
  }
};

exports.importAllFromCity = async (req, res) => {
  try {
    const { sourceCityId } = req.body;
    const targetCityId = req.params.id;

    const [sourceProducts, sourceCategories, sourceSubCategories, sourceCarouselItems] = await Promise.all([
      Product.find({ cities: sourceCityId }),
      Category.find({ cities: sourceCityId }),
      SubCategory.find({ cities: sourceCityId }),
      HeroCarousel.find({ cities: sourceCityId })
    ]);

    const productUpdatePromises = sourceProducts.map(product => {
      const sourcePriceEntry = product.cityPrices.find(cp => cp.city.toString() === sourceCityId);
      const price = sourcePriceEntry ? sourcePriceEntry.price : product.price;
      const regularPrice = sourcePriceEntry ? sourcePriceEntry.regularPrice : product.regularPrice;

      return Product.findByIdAndUpdate(product._id, {
        $addToSet: {
          cities: targetCityId,
          cityPrices: {
            city: targetCityId,
            price: price,
            regularPrice: regularPrice
          }
        }
      });
    });

    await Promise.all([
      ...productUpdatePromises,
      Category.updateMany(
        { _id: { $in: sourceCategories.map(c => c._id) } },
        { $addToSet: { cities: targetCityId } }
      ),
      SubCategory.updateMany(
        { _id: { $in: sourceSubCategories.map(s => s._id) } },
        { $addToSet: { cities: targetCityId } }
      ),
      HeroCarousel.updateMany(
        { _id: { $in: sourceCarouselItems.map(h => h._id) } },
        { $addToSet: { cities: targetCityId } }
      )
    ]);

    await purgeRedisCityCache(req, true);

    res.json({
      success: true,
      message: 'Imported all content from source city',
      counts: {
        products: sourceProducts.length,
        categories: sourceCategories.length,
        subCategories: sourceSubCategories.length,
        carouselItems: sourceCarouselItems.length
      }
    });
  } catch (err) {
    console.error('[IMPORT ALL ERROR]', err.message);
    res.status(400).json({ error: 'Failed to import all content' });
  }
};

exports.updateCityProduct = async (req, res) => {
  try {
    const cityId = req.params.cityId;
    const productId = req.params.productId;
    const updateData = req.body;

    console.log('[CITY PRODUCT UPDATE]', {
      cityId,
      productId,
      price: updateData.price,
      regularPrice: updateData.regularPrice
    });

    const existingProduct = await Product.findById(productId);
    if (!existingProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const price = updateData.price !== undefined ? parseFloat(updateData.price) : existingProduct.price;
    const regularPrice = updateData.regularPrice !== undefined ? parseFloat(updateData.regularPrice) : existingProduct.regularPrice;

    if (!existingProduct.cityPrices) {
      existingProduct.cityPrices = [];
    }

    const cityPriceIndex = existingProduct.cityPrices.findIndex(cp => cp.city.toString() === cityId);

    if (cityPriceIndex !== -1) {
      existingProduct.cityPrices[cityPriceIndex].price = price;
      existingProduct.cityPrices[cityPriceIndex].regularPrice = regularPrice;
    } else {
      existingProduct.cityPrices.push({
        city: cityId,
        price: price,
        regularPrice: regularPrice
      });
    }

    if (!existingProduct.cities.map(c => c.toString()).includes(cityId)) {
      existingProduct.cities.push(cityId);
    }

    if (updateData.name) existingProduct.name = updateData.name;
    if (updateData.material) existingProduct.material = updateData.material;
    if (updateData.size) existingProduct.size = updateData.size;
    if (updateData.colour) existingProduct.colour = updateData.colour;
    if (updateData.inStock !== undefined) existingProduct.inStock = (updateData.inStock === 'true' || updateData.inStock === true);
    if (updateData.stock !== undefined) existingProduct.stock = Number(updateData.stock);

    await existingProduct.save();

    await purgeRedisCityCache(req, true);

    res.json({
      success: true,
      message: 'Product updated with city-specific pricing',
      product: existingProduct,
      isNewProduct: false
    });
  } catch (err) {
    console.error('[UPDATE CITY PRODUCT ERROR]', err.message);
    res.status(400).json({ error: 'Failed to update city product' });
  }
};