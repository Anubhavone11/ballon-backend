const Seller = require("../models/Seller"); // adjust path/name if your model is called Vendor, Partner, etc.

// ─── GET /api/sellers ──────────────────────────────────────────────────────
// Admin-facing listing with filters, search, sort, pagination.
// Query params (all optional):
//   search    - matches name / email / businessPhone / city (case-insensitive)
//   city      - exact city match (case-insensitive)
//   pincode   - exact pincode match
//   approved  - "true" | "false"
//   blocked   - "true" | "false"
//   isOnline  - "true" | "false"
//   isPremium - "true" | "false"
//   page      - default 1
//   limit     - default 20, max 100
//   sortBy    - default "createdAt"
//   sortOrder - "asc" | "desc" (default "desc")
exports.getSellers = async (req, res) => {
  try {
    const {
      search = "",
      city,
      pincode,
      approved,
      blocked,
      isOnline,
      isPremium,
      page = 1,
      limit = 20,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const query = {};

    if (city) query.city = new RegExp(`^${escapeRegex(city)}$`, "i");
    if (pincode) query.pincode = pincode;
    if (approved !== undefined) query.approved = approved === "true";
    if (blocked !== undefined) query.blocked = blocked === "true";
    if (isOnline !== undefined) query.isOnline = isOnline === "true";
    if (isPremium !== undefined) query.isPremium = isPremium === "true";

    if (search.trim()) {
      const re = new RegExp(escapeRegex(search.trim()), "i");
      query.$or = [
        { name: re },
        { email: re },
        { businessPhone: re },
        { emergencyPhone: re },
        { city: re },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;
    const sortDir = sortOrder === "asc" ? 1 : -1;

    const [sellers, total] = await Promise.all([
      Seller.find(query)
        // Never leak OTP/auth internals to the client
        .select("-otpHash -otpAttempts -otpExpiresAt -otpLastSentAt")
        .sort({ [sortBy]: sortDir })
        .skip(skip)
        .limit(limitNum),
      Seller.countDocuments(query),
    ]);

    return res.json({
      success: true,
      sellers,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(Math.ceil(total / limitNum), 1),
      },
    });
  } catch (err) {
    console.error("getSellers error:", err);
    return res.status(500).json({ success: false, message: "Could not fetch sellers." });
  }
};
exports.checkPincode = async (req, res) => {
  try {
    const { pincode, city } = req.query;

    const cleanPincode = pincode ? pincode.toString().trim() : null;
    const cleanCity = city ? city.toString().trim() : null;

    if (!cleanPincode && !cleanCity) {
      return res.status(400).json({
        success: false,
        message: "Pincode or city is required.",
      });
    }

    if (cleanPincode && !/^\d{6}$/.test(cleanPincode)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6-digit pincode.",
      });
    }

    const baseFilter = {
      approved: true,
      blocked: false,
    };

    let count = 0;
    let matchType = null; // "pincode" | "city" | null

    // 1. Try exact pincode match first (most specific)
    if (cleanPincode) {
      count = await Seller.countDocuments({
        ...baseFilter,
        pincode: cleanPincode,
      });

      if (count > 0) {
        matchType = "pincode";
      }
    }

    // 2. Fall back to city match if no pincode match (or no pincode given at all)
    if (count === 0 && cleanCity) {
      count = await Seller.countDocuments({
        ...baseFilter,
        city: { $regex: `^${cleanCity}$`, $options: "i" },
      });

      if (count > 0) {
        matchType = "city";
      }
    }

    return res.json({
      success: true,
      available: count > 0,
      decoratorCount: count,
      matchType, // lets the frontend say "near you" vs "in your city"
      pincode: cleanPincode || null,
      city: cleanCity || null,
    });
  } catch (err) {
    console.error("checkPincode error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not check pincode.",
    });
  }
};
// ─── GET /api/sellers/:id ──────────────────────────────────────────────────
exports.getSellerById = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).select(
      "-otpHash -otpAttempts -otpExpiresAt -otpLastSentAt"
    );
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found." });
    }
    return res.json({ success: true, seller });
  } catch (err) {
    console.error("getSellerById error:", err);
    return res.status(500).json({ success: false, message: "Could not fetch seller." });
  }
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}