// routes/chatRoutes.js
const express = require("express");
const router = express.Router();

const chatController = require("../controllers/chatController");
const userAuth = require("../middleware/userAuth");
const sellerAuth = require("../middleware/sellerAuth");

// -------------------------------------------------------------------------
// Middleware: accept either a user JWT or a seller JWT on the same route.
// We attach whichever principal is present so controllers can check both.
// -------------------------------------------------------------------------
const flexAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: "No token provided." });

  const jwt = require("jsonwebtoken");

  // Try user secret first
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key");
    if (!decoded.isSeller) {
      req.user = decoded;
      return next();
    }
  } catch (_) {}

  // Try seller secret
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_SELLER || "your-secret-key");
    if (decoded.isSeller) {
      req.seller = decoded;
      return next();
    }
  } catch (_) {}

  return res.status(401).json({ success: false, message: "Invalid or expired token." });
};

// Open / fetch chat thread for a booking (user or seller)
router.get("/booking/:bookingId", flexAuth, chatController.getOrCreateChat);

// Get paginated messages
router.get("/booking/:bookingId/messages", flexAuth, chatController.getMessages);

// Send a message via REST (socket is preferred but this is the reliable fallback)
router.post("/booking/:bookingId/send", flexAuth, chatController.sendMessage);

// Mark messages as read
router.patch("/booking/:bookingId/read", flexAuth, chatController.markRead);

module.exports = router;
