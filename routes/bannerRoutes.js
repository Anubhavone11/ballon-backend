// File: admin/backend/routes/bannerRoutes.js
const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload"); // your existing CloudinaryStorage-backed multer instance
const {
  createBanner,
  getBanners,
  getBannerById,
  updateBanner,
  deleteBanner,
  toggleBannerStatus,
} = require("../controllers/bannerController");

// Swap in your project's real auth middleware here if you want writes locked down, e.g.:
// const { protect, isAdmin } = require("../middleware/authMiddleware");
// router.use(protect, isAdmin);

router.get("/", getBanners);
router.get("/:id", getBannerById);
router.post("/", upload.single("image"), createBanner);
router.put("/:id", upload.single("image"), updateBanner);
router.delete("/:id", deleteBanner);
router.patch("/:id/toggle", toggleBannerStatus);

module.exports = router;