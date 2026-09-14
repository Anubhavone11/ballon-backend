const Product = require('../models/Product');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const fs = require('fs').promises;
const path = require('path');
const { getCache, setCache, clearCache } = require('../utils/serverCache');

// Fields the shop grid / filters actually need. Admin edit forms still get
// the full document (adminView=true skips this projection). Trimming the
// payload here is most of the "send less data" win — no extra request
// needed, the response itself just gets smaller.
const LIST_PROJECTION =
  'name price regularPrice image images category subCategory rating ' +
  'date createdAt isInstantAvailable instantDeliveryTime tags stock ' +
  'inStock isBestSeller isTrending isMostLoved cityPrices';

const LIST_CACHE_TTL_MS = 60_000; // tune to how often you edit the catalog

/**
 * @desc Get all products (supports optional query filters: category, subCategory, limit, search, city, page, instant)
 * @route GET /api/products
 */
const getAllProducts = async (req, res) => {
  try {
    const { category, subCategory, limit, search, city, page, adminView, instant } = req.query;

    // ---- Server-side cache check (skip for admin views, which must be fresh) ----
    const cacheKey = `products:${JSON.stringify(req.query)}`;
    if (adminView !== 'true') {
      const cached = getCache(cacheKey);
      if (cached) {
        res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
        res.set('X-Cache', 'HIT');
        return res.status(200).json(cached);
      }
    }

    // Base query
    let query = (adminView === 'true') ? {} : {
      inStock: true,
      stock: { $gt: 0 }
    };

    if (instant === 'true') {
      query.isInstantAvailable = true;
    }

    // City filtering
    let resolvedCityId = null;
    if (city && city !== 'null' && city !== 'undefined') {
      if (mongoose.Types.ObjectId.isValid(city)) {
        resolvedCityId = new mongoose.Types.ObjectId(city);
      } else {
        const City = require('../models/City');
        const cityDoc = await City.findOne({ name: new RegExp(`^${city.trim()}$`, 'i') });
        if (cityDoc) resolvedCityId = cityDoc._id;
      }
      if (resolvedCityId) query.cities = resolvedCityId;
    }

    // Search
    if (search && search.trim()) {
      query.name = new RegExp(search.trim(), 'i');
    }

    // Resolve category to ObjectId BEFORE query — never pass raw string to Mongoose
    if (category && category !== 'undefined' && category !== 'null' && category.trim() !== '') {
      const CategoryModel = require('../models/Category');

      if (mongoose.Types.ObjectId.isValid(category)) {
        query.category = new mongoose.Types.ObjectId(category);
      } else {
        const cat = await CategoryModel.findOne({
          name: new RegExp(`^${category.trim()}$`, 'i')
        }).select('_id').lean();

        if (cat) {
          query.category = cat._id;
        } else {
          const empty = {
            success: true,
            products: [],
            total: 0,
            pagination: { total: 0, page: parseInt(page) || 1, limit: parseInt(limit) || 50, totalPages: 0 }
          };
          return res.status(200).json(empty);
        }
      }
    }

    // Same pattern for subCategory
    if (subCategory && subCategory !== 'undefined' && subCategory !== 'null' && subCategory.trim() !== '') {
      const SubCategoryModel = require('../models/SubCategory');

      if (mongoose.Types.ObjectId.isValid(subCategory)) {
        query.subCategory = new mongoose.Types.ObjectId(subCategory);
      } else {
        const subCat = await SubCategoryModel.findOne({
          name: new RegExp(`^${subCategory.trim()}$`, 'i')
        }).select('_id').lean();

        if (subCat) {
          query.subCategory = subCat._id;
        } else {
          const empty = {
            success: true,
            products: [],
            total: 0,
            pagination: { total: 0, page: parseInt(page) || 1, limit: parseInt(limit) || 50, totalPages: 0 }
          };
          return res.status(200).json(empty);
        }
      }
    }

    // Run the count and the find in parallel instead of sequentially
    let productsQuery = Product.find(query)
      .select(adminView === 'true' ? undefined : LIST_PROJECTION)
      .populate('category', 'name')
      .populate('subCategory', 'name')
      .sort({ date: -1 })
      .lean();

    if (page || limit) {
      const currentPage = parseInt(page) || 1;
      const productLimit = parseInt(limit) || 50;
      const skip = (currentPage - 1) * productLimit;
      productsQuery = productsQuery.skip(skip).limit(productLimit);
    }

    const [totalCount, products] = await Promise.all([
      Product.countDocuments(query),
      productsQuery
      // ^ No more manual populate-in-a-loop here — .populate() above does it
      //   in a single extra query per relation instead of one query PER PRODUCT.
    ]);

    // City price override
    let finalProducts = products;
    if (resolvedCityId) {
      finalProducts = products.map(product => {
        if (product.cityPrices && Array.isArray(product.cityPrices)) {
          const cityPrice = product.cityPrices.find(
            cp => cp.city && cp.city.toString() === resolvedCityId.toString()
          );
          if (cityPrice) {
            return { ...product, price: cityPrice.price, regularPrice: cityPrice.regularPrice };
          }
        }
        return product;
      });
    }

    const responseBody = {
      success: true,
      products: finalProducts,
      total: totalCount,
      pagination: {
        total: totalCount,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || finalProducts.length,
        totalPages: Math.ceil(totalCount / (parseInt(limit) || 50))
      }
    };

    if (adminView !== 'true') {
      setCache(cacheKey, responseBody, LIST_CACHE_TTL_MS);
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      res.set('X-Cache', 'MISS');
    }

    return res.status(200).json(responseBody);

  } catch (error) {
    console.error('Error fetching products:', error);
    return res.status(500).json({ success: false, message: 'Error fetching products', error: error.message });
  }
};

/**
 * @desc Get all products filtered explicitly by instant availability
 * @route GET /api/products/service/instant
 */
const getInstantProducts = async (req, res) => {
  try {
    const { city } = req.query;

    const cacheKey = `instant:${JSON.stringify(req.query)}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      res.set('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }

    let query = {
      inStock: true,
      stock: { $gt: 0 },
      isInstantAvailable: true
    };

    let resolvedCityId = null;
    if (city && city !== 'null' && city !== 'undefined') {
      if (mongoose.Types.ObjectId.isValid(city)) {
        resolvedCityId = city;
      } else {
        const City = require('../models/City');
        const cityDoc = await City.findOne({ name: new RegExp(`^${city.trim()}$`, 'i') });
        if (cityDoc) resolvedCityId = cityDoc._id;
      }
      if (resolvedCityId) query.cities = resolvedCityId;
    }

    let products = await Product.find(query)
      .select(LIST_PROJECTION)
      .populate('category', 'name')
      .populate('subCategory', 'name')
      .sort({ date: -1 })
      .lean();

    if (resolvedCityId) {
      products = products.map(product => {
        if (product.cityPrices && Array.isArray(product.cityPrices)) {
          const cityPrice = product.cityPrices.find(cp => cp.city && cp.city.toString() === resolvedCityId.toString());
          if (cityPrice) {
            return { ...product, price: cityPrice.price, regularPrice: cityPrice.regularPrice };
          }
        }
        return product;
      });
    }

    const responseBody = { success: true, count: products.length, products };
    setCache(cacheKey, responseBody, LIST_CACHE_TTL_MS);
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    res.set('X-Cache', 'MISS');

    return res.status(200).json(responseBody);
  } catch (error) {
    console.error('Error fetching instant products:', error);
    return res.status(500).json({ success: false, message: "Error fetching instant products", error: error.message });
  }
};

// ---------------------------------------------------------------------
// Everything below is unchanged from your original file, EXCEPT that
// create/update/delete now call clearCache('products:') and
// clearCache('instant:') so a new/edited product shows up immediately
// instead of waiting out the cache TTL.
// ---------------------------------------------------------------------

const getSearchSuggestions = async (req, res) => {
  try {
    const { q: query, city, limit = 10 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.json({ suggestions: [], categories: [], products: [] });
    }

    const searchTerm = query.trim();
    const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);

    const productQuery = {
      inStock: true,
      stock: { $gt: 0 }
    };

    let resolvedCityId = null;
    if (city) {
      const City = require('../models/City');

      if (mongoose.Types.ObjectId.isValid(city)) {
        resolvedCityId = city;
      } else {
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        if (cityDoc) {
          resolvedCityId = cityDoc._id;
        }
      }

      if (resolvedCityId) {
        productQuery.cities = resolvedCityId;
      }
    }

    const productSearchConditions = [
      { name: { $regex: searchTerm, $options: 'i' } },
      { material: { $regex: searchTerm, $options: 'i' } },
      { colour: { $regex: searchTerm, $options: 'i' } },
      { utility: { $regex: searchTerm, $options: 'i' } },
      { size: { $regex: searchTerm, $options: 'i' } }
    ];

    productQuery.$or = productSearchConditions;

    const productPipeline = [
      { $match: productQuery },
      {
        $lookup: {
          from: 'categories',
          localField: 'category',
          foreignField: '_id',
          as: 'categoryInfo'
        }
      },
      {
        $lookup: {
          from: 'subcategories',
          localField: 'subCategory',
          foreignField: '_id',
          as: 'subCategoryInfo'
        }
      },
      {
        $addFields: {
          categoryName: { $arrayElemAt: ['$categoryInfo.name', 0] },
          subCategoryName: { $arrayElemAt: ['$subCategoryInfo.name', 0] }
        }
      },
      {
        $addFields: {
          relevanceScore: {
            $add: [
              {
                $multiply: [
                  {
                    $size: {
                      $filter: {
                        input: searchWords,
                        cond: { $regexMatch: { input: '$name', regex: { $concat: ['(?i)', '$$this'] } } }
                      }
                    }
                  },
                  10
                ]
              },
              {
                $multiply: [
                  {
                    $size: {
                      $filter: {
                        input: searchWords,
                        cond: { $regexMatch: { input: '$categoryName', regex: { $concat: ['(?i)', '$$this'] } } }
                      }
                    }
                  },
                  8
                ]
              },
              {
                $multiply: [
                  {
                    $size: {
                      $filter: {
                        input: searchWords,
                        cond: { $regexMatch: { input: '$subCategoryName', regex: { $concat: ['(?i)', '$$this'] } } }
                      }
                    }
                  },
                  6
                ]
              }
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          name: 1,
          price: 1,
          image: 1,
          cityPrices: 1,
          isInstantAvailable: 1,
          instantDeliveryTime: 1,
          category: { $arrayElemAt: ['$categoryInfo', 0] },
          subCategory: { $arrayElemAt: ['$subCategoryInfo', 0] },
          relevanceScore: 1
        }
      },
      { $sort: { relevanceScore: -1, date: -1 } },
      { $limit: parseInt(limit) }
    ];

    const categoryQuery = { isActive: true };
    if (resolvedCityId) {
      categoryQuery.cities = resolvedCityId;
    }

    const categorySearchConditions = [
      { name: { $regex: searchTerm, $options: 'i' } },
      { description: { $regex: searchTerm, $options: 'i' } }
    ];

    categoryQuery.$or = categorySearchConditions;

    const [products, categories] = await Promise.all([
      Product.aggregate(productPipeline),
      Category.find(categoryQuery).select('name description image').limit(5)
    ]);

    const suggestions = [];

    categories.forEach(category => {
      suggestions.push({
        type: 'category',
        id: category._id,
        name: category.name,
        description: category.description,
        image: category.image
      });
    });

    products.forEach(product => {
      let displayPrice = product.price;
      if (resolvedCityId && product.cityPrices && Array.isArray(product.cityPrices)) {
        const cityPrice = product.cityPrices.find(cp => cp.city && cp.city.toString() === resolvedCityId.toString());
        if (cityPrice) displayPrice = cityPrice.price;
      }
      suggestions.push({
        type: 'product',
        id: product._id,
        name: product.name,
        price: displayPrice,
        image: product.image,
        isInstantAvailable: product.isInstantAvailable,
        instantDeliveryTime: product.instantDeliveryTime,
        category: product.category?.name,
        subCategory: product.subCategory?.name
      });
    });

    res.json({
      suggestions: suggestions.slice(0, parseInt(limit)),
      categories: categories,
      products: products
    });

  } catch (error) {
    console.error('Error fetching search suggestions:', error);
    res.status(500).json({ message: "Error fetching search suggestions", error: error.message });
  }
};

const getProductsBySection = async (req, res) => {
  try {
    const { section } = req.params;
    const { city } = req.query;

    const cacheKey = `section:${section}:${JSON.stringify(req.query)}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      return res.json(cached);
    }

    let query = {
      inStock: true,
      stock: { $gt: 0 }
    };

    if (city) {
      const City = require('../models/City');
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

    switch (section) {
      case 'bestsellers':
        query.isBestSeller = true;
        break;
      case 'trending':
        query.isTrending = true;
        break;
      case 'mostloved':
        query.isMostLoved = true;
        break;
      default:
        return res.status(400).json({ message: "Invalid section" });
    }

    let products = await Product.find(query)
      .select(LIST_PROJECTION)
      .populate('category', 'name')
      .populate('subCategory', 'name')
      .lean();

    if (city) {
      let cityId = city;
      if (!mongoose.Types.ObjectId.isValid(city)) {
        const City = require('../models/City');
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        cityId = cityDoc ? cityDoc._id : null;
      }

      if (cityId) {
        products = products.map(product => {
          if (product.cityPrices && Array.isArray(product.cityPrices)) {
            const cityPrice = product.cityPrices.find(cp => cp.city.toString() === cityId.toString());
            if (cityPrice) {
              return { ...product, price: cityPrice.price, regularPrice: cityPrice.regularPrice };
            }
          }
          return product;
        });
      }
    }

    setCache(cacheKey, products, LIST_CACHE_TTL_MS);
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    res.json(products);
  } catch (error) {
    console.error(`Error fetching ${section} products:`, error);
    res.status(500).json({ message: `Error fetching ${section} products`, error: error.message });
  }
};

const getProduct = async (req, res) => {
  try {
    const { id } = req.params;
    let product;

    if (mongoose.Types.ObjectId.isValid(id)) {
      product = await Product.findById(id)
        .populate('category', 'name slug')
        .populate('subCategory', 'name slug');
    }

    if (!product) {
      const nameFromSlug = decodeURIComponent(id).replace(/-/g, ' ');
      product = await Product.findOne({
        name: new RegExp(`^${nameFromSlug}$`, 'i')
      })
        .populate('category', 'name slug')
        .populate('subCategory', 'name slug');
    }

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const { city } = req.query;
    if (city) {
      let cityId = city;
      if (!mongoose.Types.ObjectId.isValid(city)) {
        const City = require('../models/City');
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        cityId = cityDoc ? cityDoc._id : null;
      }

      if (cityId && product.cityPrices && Array.isArray(product.cityPrices)) {
        const cityPrice = product.cityPrices.find(cp => cp.city.toString() === cityId.toString());
        if (cityPrice) {
          const productObj = product.toObject();
          productObj.price = cityPrice.price;
          productObj.regularPrice = cityPrice.regularPrice;
          res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
          return res.json(productObj);
        }
      }
    }

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(product);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ message: "Error fetching product", error: error.message });
  }
};

const createProductWithFiles = async (req, res) => {
  try {
    if (!req.files || !req.files.mainImage) {
      return res.status(400).json({
        error: 'Main image is required.',
        message: 'Please upload a main image for the product'
      });
    }

    const files = req.files;
    const productData = req.body;

    const requiredFields = [
      "name", "material", "size", "colour",
      "category", "utility", "price", "regularPrice"
    ];

    const missingFields = requiredFields.filter(field => !productData[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
    }

    const price = parseFloat(productData.price);
    const regularPrice = parseFloat(productData.regularPrice);

    if (isNaN(price) || price < 0 || isNaN(regularPrice) || regularPrice < 0) {
      return res.status(400).json({ error: 'Invalid price value' });
    }

    if (price > regularPrice) {
      return res.status(400).json({ error: 'Price cannot be greater than regular price' });
    }

    const stock = Number(productData.stock);
    if (isNaN(stock) || stock < 0) {
      return res.status(400).json({ error: 'Invalid stock value' });
    }

    const imagePaths = [];
    if (files.mainImage && files.mainImage[0]) {
      imagePaths.push(files.mainImage[0].path);
    }
    for (let i = 1; i <= 9; i++) {
      if (files[`image${i}`] && files[`image${i}`][0]) {
        imagePaths.push(files[`image${i}`][0].path);
      }
    }

    const productObject = {
      name: productData.name,
      material: productData.material,
      size: productData.size,
      colour: productData.colour,
      category: productData.category,
      subCategory: productData.subCategory && productData.subCategory.trim() !== '' ? productData.subCategory : undefined,
      utility: productData.utility,
      care: productData.care,
      included: productData.included ? JSON.parse(productData.included) : [],
      excluded: productData.excluded ? JSON.parse(productData.excluded) : [],
      price: parseFloat(productData.price),
      regularPrice: parseFloat(productData.regularPrice),
      image: imagePaths[0],
      images: imagePaths,
      inStock: productData.inStock === 'true',
      isBestSeller: productData.isBestSeller === 'true',
      isTrending: productData.isTrending === 'true',
      isMostLoved: productData.isMostLoved === 'true',
      codAvailable: productData.codAvailable !== 'false',
      stock: Number(productData.stock) || 0,
      isInstantAvailable: productData.isInstantAvailable === 'true' || productData.isInstantAvailable === true,
      instantDeliveryTime: productData.instantDeliveryTime || "2 hr",
      cities: productData.cities ? (typeof productData.cities === 'string' ? JSON.parse(productData.cities) : productData.cities) : [],
      cityPrices: productData.cityPrices ? (typeof productData.cityPrices === 'string' ? JSON.parse(productData.cityPrices) : productData.cityPrices) : []
    };

    const newProduct = new Product(productObject);
    const savedProduct = await newProduct.save();

    // Invalidate list caches so this product appears immediately
    clearCache('products:');
    clearCache('instant:');
    clearCache('section:');

    res.status(201).json({
      message: "Product created successfully",
      product: savedProduct,
    });
  } catch (error) {
    console.error('=== Error creating product ===');
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ message: "Validation Error", error: validationErrors.join(', ') });
    }
    res.status(500).json({ message: "Error creating product", error: error.message });
  }
};

const updateProductWithFiles = async (req, res) => {
  try {
    const id = req.params.id;
    const files = req.files || {};
    const productData = req.body;

    const existingProduct = await Product.findById(id);
    if (!existingProduct) {
      return res.status(404).json({ message: "Product not found" });
    }

    let imagePaths = existingProduct.images || [];
    if (!Array.isArray(imagePaths)) {
      imagePaths = existingProduct.image ? [existingProduct.image] : [];
    }

    if (files.mainImage && files.mainImage[0]) {
      imagePaths[0] = files.mainImage[0].path;
    }

    for (let i = 1; i <= 9; i++) {
      if (files[`image${i}`] && files[`image${i}`][0]) {
        imagePaths[i] = files[`image${i}`][0].path;
      }
    }

    const updatedProductData = {
      name: productData.name || existingProduct.name,
      material: productData.material || existingProduct.material,
      size: productData.size || existingProduct.size,
      colour: productData.colour || existingProduct.colour,
      category: productData.category || existingProduct.category,
      subCategory: productData.subCategory && productData.subCategory.trim() !== '' ? productData.subCategory : (productData.subCategory === '' ? undefined : existingProduct.subCategory),
      utility: productData.utility || existingProduct.utility,
      care: productData.care || existingProduct.care,
      included: productData.included ? JSON.parse(productData.included) : existingProduct.included,
      excluded: productData.excluded ? JSON.parse(productData.excluded) : existingProduct.excluded,
      price: productData.price ? parseFloat(productData.price) : existingProduct.price,
      regularPrice: productData.regularPrice ? parseFloat(productData.regularPrice) : existingProduct.regularPrice,
      image: imagePaths[0],
      images: imagePaths,
      inStock: productData.inStock !== undefined ? (productData.inStock === 'true') : existingProduct.inStock,
      isBestSeller: productData.isBestSeller !== undefined ? (productData.isBestSeller === 'true') : existingProduct.isBestSeller,
      isTrending: productData.isTrending !== undefined ? (productData.isTrending === 'true') : existingProduct.isTrending,
      isMostLoved: productData.isMostLoved !== undefined ? (productData.isMostLoved === 'true') : existingProduct.isMostLoved,
      codAvailable: productData.codAvailable !== undefined ? (productData.codAvailable !== 'false') : existingProduct.codAvailable,
      stock: productData.stock !== undefined ? Number(productData.stock) : existingProduct.stock,
      isInstantAvailable: productData.isInstantAvailable !== undefined ? (productData.isInstantAvailable === 'true' || productData.isInstantAvailable === true) : existingProduct.isInstantAvailable,
      instantDeliveryTime: productData.instantDeliveryTime !== undefined ? productData.instantDeliveryTime : existingProduct.instantDeliveryTime,
      cities: productData.cities ? (typeof productData.cities === 'string' ? JSON.parse(productData.cities) : productData.cities) : existingProduct.cities,
      cityPrices: productData.cityPrices ? (typeof productData.cityPrices === 'string' ? JSON.parse(productData.cityPrices) : productData.cityPrices) : existingProduct.cityPrices
    };

    const result = await Product.findByIdAndUpdate(id, updatedProductData, { new: true });

    clearCache('products:');
    clearCache('instant:');
    clearCache('section:');

    res.json({ message: "Product updated successfully", product: result });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ message: "Error updating product", error: error.message });
  }
};

const updateProductSections = async (req, res) => {
  try {
    const { id } = req.params;
    const { isBestSeller, isTrending, isMostLoved } = req.body;

    if (isBestSeller === undefined && isTrending === undefined && isMostLoved === undefined) {
      return res.status(400).json({ message: "At least one section flag must be provided" });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const updates = {};
    if (isBestSeller !== undefined) updates.isBestSeller = isBestSeller;
    if (isTrending !== undefined) updates.isTrending = isTrending;
    if (isMostLoved !== undefined) updates.isMostLoved = isMostLoved;

    const updatedProduct = await Product.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    clearCache('products:');
    clearCache('section:');

    res.json({
      message: "Product sections updated successfully",
      product: updatedProduct
    });
  } catch (error) {
    console.error('=== Error Updating Sections ===');
    res.status(500).json({ message: "Error updating product sections", error: error.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    await Product.findByIdAndDelete(req.params.id);

    clearCache('products:');
    clearCache('instant:');
    clearCache('section:');

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ message: "Error deleting product", error: error.message });
  }
};

module.exports = {
  getAllProducts,
  getInstantProducts,
  getSearchSuggestions,
  getProductsBySection,
  getProduct,
  createProductWithFiles,
  updateProductWithFiles,
  updateProductSections,
  deleteProduct
};