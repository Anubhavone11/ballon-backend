// models/Addon.js
const mongoose = require("mongoose");

const addonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      default: "",
      trim: true
    },
    price: {
      type: Number,
      required: true
    },
    image: {
      type: String,
      default: ""
    },
    isActive: {
      type: Boolean,
      default: true
    },

    // 🔗 Scope: does this addon show up on every product, or only specific ones?
    appliesToAll: {
      type: Boolean,
      default: true
    },

    // Used only when appliesToAll = false
    products: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product"
      }
    ],
    categories: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Category"
      }
    ],

    // Optional: cap how many of this addon can be added per order item
    maxQuantity: {
      type: Number,
      default: 5
    },

    sortOrder: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

addonSchema.index({ isActive: 1 });
addonSchema.index({ products: 1 });
addonSchema.index({ categories: 1 });

module.exports = mongoose.model("Addon", addonSchema);