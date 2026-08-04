// File: admin/backend/models/Banner.js
const mongoose = require("mongoose");

const BANNER_TYPES = ["category", "instant", "promotion", "header", "product"];

const bannerSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    // category  -> shown on the "All Categories" page
    // instant   -> instant/quick-action banner (e.g. flash sale, homepage strip)
    // promotion -> platform achievement / marketing banner (e.g. "50,000+ orders delivered")
    type: {
      type: String,
      enum: BANNER_TYPES,
      required: true,
      default: "instant",
      index: true,
    },

    // Cloudinary image
    image: {
      type: String, // secure_url returned by Cloudinary
      required: true,
    },
    imagePublicId: {
      type: String, // needed to delete/replace the image on Cloudinary
      required: true,
    },

    // Used mainly by type = "category": which category this banner links to.
    // Leave empty / null to mean "All Categories".
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },

    // Used mainly by type = "instant": optional external/internal redirect link
    link: {
      type: String,
      trim: true,
      default: "",
    },

    // Used mainly by type = "promotion": achievement headline + supporting text
    // e.g. achievementValue = "50,000+", achievementLabel = "Orders Delivered"
    achievementValue: {
      type: String,
      trim: true,
      default: "",
    },
    achievementLabel: {
      type: String,
      trim: true,
      default: "",
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    sortOrder: {
      type: Number,
      default: 0,
    },

    // Optional scheduling window (useful for promotions/instant banners)
    startDate: {
      type: Date,
      default: null,
    },
    endDate: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

bannerSchema.index({ type: 1, isActive: 1, sortOrder: 1 });

bannerSchema.statics.TYPES = BANNER_TYPES;

module.exports = mongoose.model("Banner", bannerSchema);