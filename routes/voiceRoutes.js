// File: routes/voiceRoutes.js
const express = require("express");
const router = express.Router();
const voiceController = require("../controllers/voiceController");
const userAuth = require("../middleware/userAuth");  // Your active token validator middleware

// Standard secure post channel hook
router.post("/generate-token", userAuth, voiceController.initializeSecureCallSession);

module.exports = router;