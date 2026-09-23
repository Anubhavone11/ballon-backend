const Seller = require("../models/Seller"); // adjust path/name if your model is called Vendor, Partner, etc.

// Fields that must never leave the server
const HIDDEN_FIELDS = "-otpHash -otpAttempts -otpExpiresAt -otpLastSentAt";

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
        .select(HIDDEN_FIELDS)
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
        city: { $regex: `^${escapeRegex(cleanCity)}$`, $options: "i" },
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
    const seller = await Seller.findById(req.params.id).select(HIDDEN_FIELDS);
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found." });
    }
    return res.json({ success: true, seller });
  } catch (err) {
    console.error("getSellerById error:", err);
    return res.status(500).json({ success: false, message: "Could not fetch seller." });
  }
};

// ─── PUT /api/seller/:id/details  (ADMIN ONLY) ─────────────────────────────
// Lets an admin edit a seller's profile, status flags and ledger counters.
// Only whitelisted fields are ever written, so OTP/auth internals, _id and
// createdAt can't be changed through this endpoint.
const STRING_FIELDS = [
  "name",
  "email",
  "businessPhone",
  "emergencyPhone",
  "state",
  "city",
  "address",
  "pincode",
  "description",
];
const BOOLEAN_FIELDS = [
  "approved",
  "blocked",
  "verified",
  "phoneVerified",
  "isPremium",
  "isOnline",
  "isAllocated",
];
const NUMBER_FIELDS = [
  "rating",
  "completedBookings",
  "paidBookingsCount",
  "totalPaymentsReceived",
];
const REQUIRED_STRING_FIELDS = ["name", "email", "businessPhone", "state", "city", "address", "pincode"];

exports.updateSellerDetails = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id);
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found." });
    }

    const body = req.body || {};
    const updates = {};

    // ── Strings ──
    for (const field of STRING_FIELDS) {
      if (body[field] === undefined) continue;
      let value = String(body[field]).trim();
      if (field === "email") value = value.toLowerCase();

      if (REQUIRED_STRING_FIELDS.includes(field) && !value) {
        return res.status(400).json({ success: false, message: `${field} cannot be empty.` });
      }
      updates[field] = value;
    }

    if (updates.email && !/^\S+@\S+\.\S+$/.test(updates.email)) {
      return res.status(400).json({ success: false, message: "Enter a valid email address." });
    }
    if (updates.pincode && !/^[1-9][0-9]{5}$/.test(updates.pincode)) {
      return res.status(400).json({ success: false, message: "Enter a valid 6-digit pincode." });
    }

    // ── Booleans ──
    for (const field of BOOLEAN_FIELDS) {
      if (body[field] === undefined) continue;
      updates[field] = body[field] === true || body[field] === "true";
    }

    // ── Numbers ──
    for (const field of NUMBER_FIELDS) {
      if (body[field] === undefined) continue;
      const num = Number(body[field]);
      if (isNaN(num) || num < 0) {
        return res.status(400).json({ success: false, message: `${field} must be a number, 0 or more.` });
      }
      if (field === "rating" && num > 5) {
        return res.status(400).json({ success: false, message: "Rating must be between 0 and 5." });
      }
      updates[field] = num;
    }

    // ── Uniqueness checks (email + login phone), excluding this seller ──
    if (updates.email && updates.email !== seller.email) {
      const emailTaken = await Seller.exists({ email: updates.email, _id: { $ne: seller._id } });
      if (emailTaken) {
        return res.status(409).json({ success: false, message: "Another seller already uses this email." });
      }
    }
    if (updates.businessPhone && updates.businessPhone !== seller.businessPhone) {
      const phoneTaken = await Seller.exists({
        businessPhone: updates.businessPhone,
        _id: { $ne: seller._id },
      });
      if (phoneTaken) {
        return res.status(409).json({ success: false, message: "Another seller already uses this business phone." });
      }
      // A new login number hasn't been OTP-verified yet, unless the admin explicitly says so
      if (body.phoneVerified === undefined) updates.phoneVerified = false;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No valid fields to update." });
    }

    const updated = await Seller.findByIdAndUpdate(
      seller._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select(HIDDEN_FIELDS);

    return res.json({ success: true, message: "Vendor updated.", seller: updated });
  } catch (err) {
    console.error("updateSellerDetails error:", err);

    // Mongo duplicate key (race condition on unique email / businessPhone)
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || "field";
      return res.status(409).json({ success: false, message: `That ${field} is already in use.` });
    }
    // Mongoose schema validation errors
    if (err.name === "ValidationError") {
      const first = Object.values(err.errors)[0];
      return res.status(400).json({ success: false, message: first?.message || "Validation failed." });
    }
    return res.status(500).json({ success: false, message: "Could not update seller." });
  }
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}