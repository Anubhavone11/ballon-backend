// File: admin/backend/controllers/bannerController.js
const Banner = require("../models/Banner");
const cloudinary = require("../config/cloudinary");

const VALID_TYPES = Banner.TYPES; // ['category', 'instant', 'promotion']

/**
 * Purge Redis cache keys for banners
 */
const purgeRedisBannerCache = async (req) => {
  try {
    const redis = req.app.get("redisClient");
    if (!redis || !redis.isReady) return;

    const keys = await redis.keys("cache:/api/banners*");
    if (keys.length > 0) {
      await redis.del(keys);
      console.log(`[REDIS PURGED] Cleared ${keys.length} banner cache key(s)`);
    }
  } catch (err) {
    console.error("[REDIS PURGE ERROR]", err.message);
  }
};

// ------------------------------------------------------------------
// CREATE  -> POST /api/banners
// ------------------------------------------------------------------
exports.createBanner = async (req, res) => {
  try {
    const {
      title,
      type,
      category,
      link,
      achievementValue,
      achievementLabel,
      description,
      isActive,
      sortOrder,
      startDate,
      endDate,
    } = req.body;

    if (!title || !type) {
      return res.status(400).json({ success: false, message: "Title and type are required" });
    }

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
      });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Banner image is required" });
    }

    const imageUrl = req.file.path;
    const imagePublicId = req.file.filename;

    const banner = await Banner.create({
      title,
      type,
      image: imageUrl,
      imagePublicId: imagePublicId,
      category: type === "category" && category ? category : null,
      link: link || "",
      achievementValue: achievementValue || "",
      achievementLabel: achievementLabel || "",
      description: description || "",
      isActive: isActive === undefined ? true : isActive === "true" || isActive === true,
      sortOrder: sortOrder ? Number(sortOrder) : 0,
      startDate: startDate || null,
      endDate: endDate || null,
    });

    // Invalidate Redis cache
    await purgeRedisBannerCache(req);

    return res.status(201).json({ success: true, message: "Banner created successfully", data: banner });
  } catch (error) {
    console.error("createBanner error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to create banner", error: error.message });
  }
};

// ------------------------------------------------------------------
// READ ALL -> GET /api/banners?type=category&isActive=true
// ------------------------------------------------------------------
exports.getBanners = async (req, res) => {
  try {
    const { type, isActive } = req.query;
    const filter = {};

    if (type) {
      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: "Invalid type filter" });
      }
      filter.type = type;
    }

    if (isActive !== undefined) {
      filter.isActive = isActive === "true";
    }

    const banners = await Banner.find(filter)
      .populate("category", "name slug")
      .sort({ sortOrder: 1, createdAt: -1 });

    return res.status(200).json({ success: true, count: banners.length, data: banners });
  } catch (error) {
    console.error("getBanners error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to fetch banners", error: error.message });
  }
};

// ------------------------------------------------------------------
// READ ONE -> GET /api/banners/:id
// ------------------------------------------------------------------
exports.getBannerById = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id).populate("category", "name slug");
    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    return res.status(200).json({ success: true, data: banner });
  } catch (error) {
    console.error("getBannerById error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to fetch banner", error: error.message });
  }
};

// ------------------------------------------------------------------
// UPDATE -> PUT /api/banners/:id
// ------------------------------------------------------------------
exports.updateBanner = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }

    const {
      title,
      type,
      category,
      link,
      achievementValue,
      achievementLabel,
      description,
      isActive,
      sortOrder,
      startDate,
      endDate,
    } = req.body;

    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
      });
    }

    if (req.file) {
      if (banner.imagePublicId) {
        await cloudinary.uploader.destroy(banner.imagePublicId);
      }
      banner.image = req.file.path;
      banner.imagePublicId = req.file.filename;
    }

    if (title !== undefined) banner.title = title;
    if (type !== undefined) banner.type = type;
    if (category !== undefined) banner.category = type === "category" ? category || null : banner.category;
    if (link !== undefined) banner.link = link;
    if (achievementValue !== undefined) banner.achievementValue = achievementValue;
    if (achievementLabel !== undefined) banner.achievementLabel = achievementLabel;
    if (description !== undefined) banner.description = description;
    if (isActive !== undefined) banner.isActive = isActive === "true" || isActive === true;
    if (sortOrder !== undefined) banner.sortOrder = Number(sortOrder);
    if (startDate !== undefined) banner.startDate = startDate || null;
    if (endDate !== undefined) banner.endDate = endDate || null;

    await banner.save();

    // Invalidate Redis cache
    await purgeRedisBannerCache(req);

    return res.status(200).json({ success: true, message: "Banner updated successfully", data: banner });
  } catch (error) {
    console.error("updateBanner error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to update banner", error: error.message });
  }
};

// ------------------------------------------------------------------
// DELETE -> DELETE /api/banners/:id
// ------------------------------------------------------------------
exports.deleteBanner = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }

    if (banner.imagePublicId) {
      await cloudinary.uploader.destroy(banner.imagePublicId);
    }
    
    await banner.deleteOne();

    // Invalidate Redis cache
    await purgeRedisBannerCache(req);

    return res.status(200).json({ success: true, message: "Banner deleted successfully" });
  } catch (error) {
    console.error("deleteBanner error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to delete banner", error: error.message });
  }
};

// ------------------------------------------------------------------
// TOGGLE ACTIVE -> PATCH /api/banners/:id/toggle
// ------------------------------------------------------------------
exports.toggleBannerStatus = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    
    banner.isActive = !banner.isActive;
    await banner.save();

    // Invalidate Redis cache
    await purgeRedisBannerCache(req);

    return res.status(200).json({ success: true, message: "Banner status updated", data: banner });
  } catch (error) {
    console.error("toggleBannerStatus error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to toggle banner status", error: error.message });
  }
};