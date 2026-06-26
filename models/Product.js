const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  material: { type: String, required: true, trim: true },
  size: { type: String, required: true, trim: true },
  colour: { type: String, required: true, trim: true },
  
  // Reference to the Category model
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category', 
    required: true
  },

  // Reference to the SubCategory model
  subCategory: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubCategory', 
    required: false
  },

  // ⚡ NEW: INSTANT DECOR SERVICE ENGINE FIELDS
  isInstantAvailable: {
    type: Boolean,
    default: false
  },
  instantDeliveryTime: {
    type: String, 
    trim: true,
    default: "standard" // Default delivery setup window fallback (e.g., "1 hr", "2 hr")
  },

  utility: { type: String, required: true, trim: true },
  care: { type: String, required: true, trim: true },
  included: [{ type: String, trim: true }],
  excluded: [{ type: String, trim: true }],
  price: { type: Number, required: true },
  regularPrice: { type: Number, required: true },
  image: { type: String, required: true },
  images: [{ type: String }],
  inStock: { type: Boolean, default: true },
  stock: { type: Number, default: 10 },
  isBestSeller: { type: Boolean, default: false },
  isTrending: { type: Boolean, default: false },
  isMostLoved: { type: Boolean, default: false },
  rating: { type: Number, default: 0 },
  reviews: { type: Number, default: 0 },
  codAvailable: { type: Boolean, default: true },
  
  // Cities where this product is available
  cities: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'City'
  }],
  
  // City-specific pricing overrides
  cityPrices: [{
    city: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'City',
      required: true
    },
    price: {
      type: Number,
      required: true
    },
    regularPrice: {
      type: Number,
      required: true
    }
  }],
  date: { type: Date, default: Date.now }
});

// Create and export the Product model
const Product = mongoose.model('Product', productSchema);
module.exports = Product;