const Product = require('../models/Product');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const fs = require('fs').promises;
const path = require('path');

/**
 * @desc Get all products (supports optional query filters: category, subCategory, limit, search, city, page, instant)
 * @route GET /api/products
 */
const getAllProducts = async (req, res) => {
  try {
    const { category, subCategory, limit, search, city, page, adminView, instant } = req.query;
    console.log("getAllProducts endpoint reached with params:", req.query);

    // Base query: filter for public store views, clear for admin view
    let query = (adminView === 'true' || adminView === true) ? {} : {
      inStock: true,
      stock: { $gt: 0 }
    };

    // Handle Instant query parameter dynamically
    if (instant === 'true' || instant === true) {
      query.isInstantAvailable = true;
    }

    // If city provided, resolve it and filter
    let resolvedCityId = null;
    if (city && city !== 'null' && city !== 'undefined') {
      if (mongoose.Types.ObjectId.isValid(city)) {
        resolvedCityId = city;
      } else {
        const City = require('../models/City');
        const cityDoc = await City.findOne({ name: new RegExp(`^${city}$`, 'i') });
        if (cityDoc) {
          resolvedCityId = cityDoc._id;
        }
      }

      if (resolvedCityId) {
        query.cities = resolvedCityId;
      }
    }

    // Handle search
    if (search && search.trim()) {
      query.name = new RegExp(search.trim(), 'i');
    }

    // ⚡ SAFE HYBRID CATEGORY SHIELD (Handles ObjectIds, String Names, and Mixed Document Data)
    if (category && category !== 'undefined' && category !== 'null' && category.trim() !== '') {
      const Category = require('../models/Category');
      
      if (mongoose.Types.ObjectId.isValid(category)) {
        query.category = category;
      } else {
        const cat = await Category.findOne({ name: new RegExp(`^${category.trim()}$`, 'i') });
        if (cat) {
          // If a category document is found, we query for products containing its ObjectId
          // OR products containing the exact string fallback name
          query.$or = [
            { category: cat._id },
            { category: category.trim() }
          ];
        } else {
          // Fallback if no matching Category document exists in database
          query.category = category.trim();
        }
      }
    }

    // Handle subCategory (Handles both String Names and ObjectIds)
    if (subCategory && subCategory !== 'undefined' && subCategory !== 'null' && subCategory.trim() !== '') {
      const SubCategory = require('../models/SubCategory');
      
      if (mongoose.Types.ObjectId.isValid(subCategory)) {
        query.subCategory = subCategory;
      } else {
        const subCat = await SubCategory.findOne({ name: new RegExp(`^${subCategory.trim()}$`, 'i') });
        if (subCat) {
          query.$or = query.$or || [];
          query.$or.push({ subCategory: subCat._id }, { subCategory: subCategory.trim() });
        } else {
          query.subCategory = subCategory.trim();
        }
      }
    }

    // ⚡ FIX: We separate find() from populate() execution streams to handle mixed values safely
    let productsQuery = Product.find(query).sort({ date: -1 });

    const totalCount = await Product.countDocuments(query);

    // Apply pagination
    if (page || limit) {
      const currentPage = parseInt(page) || 1;
      const productLimit = parseInt(limit) || 50;
      const skip = (currentPage - 1) * productLimit;
      productsQuery = productsQuery.skip(skip).limit(productLimit);
    }

    // Fetch products as plain JavaScript objects
    let products = await productsQuery.lean();

    // ⚡ FIX: Manually resolve populate tasks on text string entries to eliminate 500 CastErrors
    const CategoryModel = require('../models/Category');
    const SubCategoryModel = require('../models/SubCategory');

    products = await Promise.all(products.map(async (product) => {
      // 1. Safe Category Resolution
      if (product.category) {
        if (mongoose.Types.ObjectId.isValid(product.category)) {
          const populatedCat = await CategoryModel.findById(product.category).select('name').lean();
          product.category = populatedCat || { _id: product.category, name: "Unknown Category" };
        } else if (typeof product.category === 'string') {
          // Map legacy text field values seamlessly to match storefront object templates
          product.category = { name: product.category };
        }
      }

      // 2. Safe Subcategory Resolution
      if (product.subCategory) {
        if (mongoose.Types.ObjectId.isValid(product.subCategory)) {
          const populatedSubCat = await SubCategoryModel.findById(product.subCategory).select('name').lean();
          product.subCategory = populatedSubCat || { _id: product.subCategory, name: "Unknown Subcategory" };
        } else if (typeof product.subCategory === 'string') {
          product.subCategory = { name: product.subCategory };
        }
      }

      return product;
    }));

    // Adjust prices for city if selected
    if (resolvedCityId) {
      products = products.map(product => {
        if (product.cityPrices && Array.isArray(product.cityPrices)) {
          const cityPrice = product.cityPrices.find(cp => cp.city && cp.city.toString() === resolvedCityId.toString());
          if (cityPrice) {
            return {
              ...product,
              price: cityPrice.price,
              regularPrice: cityPrice.regularPrice
            };
          }
        }
        return product;
      });
    }

    return res.status(200).json({
      success: true,
      products,
      total: totalCount,
      pagination: {
        total: totalCount,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || products.length,
        totalPages: Math.ceil(totalCount / (parseInt(limit) || 50))
      }
    });

  } catch (error) {
    console.error('Error fetching products:', error);
    return res.status(500).json({ success: false, message: "Error fetching products", error: error.message });
  }
};
/**
 * @desc Get all products filtered explicitly by instant availability
 * @route GET /api/products/service/instant
 */
const getInstantProducts = async (req, res) => {
  try {
    const { city } = req.query;
 console.log("instant");
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
      .populate('category', 'name')
      .populate('subCategory', 'name')
      .sort({ date: -1 })
      .lean();

    if (resolvedCityId) {
      products = products.map(product => {
        if (product.cityPrices && Array.isArray(product.cityPrices)) {
          const cityPrice = product.cityPrices.find(cp => cp.city && cp.city.toString() === resolvedCityId.toString());
          if (cityPrice) {
            return {
              ...product,
              price: cityPrice.price,
              regularPrice: cityPrice.regularPrice
            };
          }
        }
        return product;
      });
    }

    return res.status(200).json({
      success: true,
      count: products.length,
      products
    });
  } catch (error) {
    console.error('Error fetching instant products:', error);
    return res.status(500).json({ success: false, message: "Error fetching instant products", error: error.message });
  }
};

// Get search suggestions with categories and products
const getSearchSuggestions = async (req, res) => {
  try {
    const { q: query, city, limit = 10 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.json({ suggestions: [], categories: [], products: [] });
    }

    const searchTerm = query.trim();
    const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);

    // Base query for products
    const productQuery = {
      inStock: true,
      stock: { $gt: 0 }
    };

    // Add city filter if provided
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

    // Search conditions for products
    const productSearchConditions = [
      { name: { $regex: searchTerm, $options: 'i' } },
      { material: { $regex: searchTerm, $options: 'i' } },
      { colour: { $regex: searchTerm, $options: 'i' } },
      { utility: { $regex: searchTerm, $options: 'i' } },
      { size: { $regex: searchTerm, $options: 'i' } }
    ];

    productQuery.$or = productSearchConditions;

    // Get matching products with aggregation
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

    // Get matching categories
    const categoryQuery = { isActive: true };
    if (resolvedCityId) {
      categoryQuery.cities = resolvedCityId;
    }

    const categorySearchConditions = [
      { name: { $regex: searchTerm, $options: 'i' } },
      { description: { $regex: searchTerm, $options: 'i' } }
    ];

    categoryQuery.$or = categorySearchConditions;

    // Execute queries in parallel
    const [products, categories] = await Promise.all([
      Product.aggregate(productPipeline),
      Category.find(categoryQuery).select('name description image').limit(5)
    ]);

    // Create suggestions array
    const suggestions = [];

    // Add category suggestions
    categories.forEach(category => {
      suggestions.push({
        type: 'category',
        id: category._id,
        name: category.name,
        description: category.description,
        image: category.image
      });
    });

    // Add product suggestions
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

// Get products by section
const getProductsBySection = async (req, res) => {
  try {
    const { section } = req.params;
    const { city } = req.query;

    let query = {
      inStock: true,
      stock: { $gt: 0 }
    };

    // Add city filter if provided
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
      .populate('category', 'name')
      .populate('subCategory', 'name');

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
              const productObj = product.toObject();
              return {
                ...productObj,
                price: cityPrice.price,
                regularPrice: cityPrice.regularPrice
              };
            }
          }
          return product;
        });
      }
    }

    res.json(products);
  } catch (error) {
    console.error(`Error fetching ${section} products:`, error);
    res.status(500).json({ message: `Error fetching ${section} products`, error: error.message });
  }
};

// Get single product
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
          return res.json(productObj);
        }
      }
    }

    res.json(product);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ message: "Error fetching product", error: error.message });
  }
};

// Create new product with file upload
const createProductWithFiles = async (req, res) => {
  try {
    console.log('=== Product Creation Request ===');
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

      // ⚡ NEW: Instant Decor fields extraction
      isInstantAvailable: productData.isInstantAvailable === 'true' || productData.isInstantAvailable === true,
      instantDeliveryTime: productData.instantDeliveryTime || "2 hr",

      cities: productData.cities ? (typeof productData.cities === 'string' ? JSON.parse(productData.cities) : productData.cities) : [],
      cityPrices: productData.cityPrices ? (typeof productData.cityPrices === 'string' ? JSON.parse(productData.cityPrices) : productData.cityPrices) : []
    };

    const newProduct = new Product(productObject);
    const savedProduct = await newProduct.save();

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

// Update product with file upload
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

      // ⚡ NEW: Instant Decor fields alignment updates
      isInstantAvailable: productData.isInstantAvailable !== undefined ? (productData.isInstantAvailable === 'true' || productData.isInstantAvailable === true) : existingProduct.isInstantAvailable,
      instantDeliveryTime: productData.instantDeliveryTime !== undefined ? productData.instantDeliveryTime : existingProduct.instantDeliveryTime,

      cities: productData.cities ? (typeof productData.cities === 'string' ? JSON.parse(productData.cities) : productData.cities) : existingProduct.cities,
      cityPrices: productData.cityPrices ? (typeof productData.cityPrices === 'string' ? JSON.parse(productData.cityPrices) : productData.cityPrices) : existingProduct.cityPrices
    };

    const result = await Product.findByIdAndUpdate(id, updatedProductData, { new: true });
    res.json({ message: "Product updated successfully", product: result });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ message: "Error updating product", error: error.message });
  }
};

// Update product section flags
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

    res.json({
      message: "Product sections updated successfully",
      product: updatedProduct
    });
  } catch (error) {
    console.error('=== Error Updating Sections ===');
    res.status(500).json({ message: "Error updating product sections", error: error.message });
  }
};

// Delete product
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ message: "Error deleting product", error: error.message });
  }
};

module.exports = {
  getAllProducts,
  getInstantProducts, // Exported to routing channel
  getSearchSuggestions,
  getProductsBySection,
  getProduct,
  createProductWithFiles,
  updateProductWithFiles,
  updateProductSections,
  deleteProduct
};