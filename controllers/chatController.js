// controllers/chatController.js
const mongoose = require("mongoose");
const Chat = require("../models/Chat");
const Booking = require("../models/Booking");

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// =========================================================================
// GET OR CREATE CHAT THREAD FOR A BOOKING
// Called by both user and seller to open a conversation
// =========================================================================
exports.getOrCreateChat = async (req, res) => {
  try {
    const { bookingId } = req.params;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID." });
    }

    // Determine caller identity
    const callerId = req.user?.id || req.seller?.id;
    const callerType = req.user ? "user" : "seller";

    // Load booking to verify the caller is a party to this booking
    const booking = await Booking.findById(bookingId)
      .populate("userId", "name phone email")
      .populate("sellerId", "name businessPhone passportPhoto city rating");

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    // Authorization: only the booking's user or assigned seller may chat
    const isUser = callerType === "user" && String(booking.userId?._id || booking.userId) === String(callerId);
    const isSeller = callerType === "seller" && String(booking.sellerId?._id || booking.sellerId) === String(callerId);

    if (!isUser && !isSeller) {
      return res.status(403).json({ success: false, message: "You are not a party to this booking." });
    }

    // Seller must be assigned before chat is available
    if (!booking.sellerId) {
      return res.status(400).json({ success: false, message: "No seller has been assigned to this booking yet." });
    }

    const sellerId = booking.sellerId?._id || booking.sellerId;
    const userId = booking.userId?._id || booking.userId;

    // Upsert: find or create chat thread
    let chat = await Chat.findOne({ bookingId, userId, sellerId });

    if (!chat) {
      chat = await Chat.create({
        bookingId,
        userId,
        sellerId,
        messages: [],
      });
    }

    // Populate user + seller details for UI
    await chat.populate("userId", "name phone email");
    await chat.populate("sellerId", "name businessPhone passportPhoto city rating");

    // Mark unread messages as read for this caller
    let didMarkRead = false;
    chat.messages.forEach((msg) => {
      if (msg.senderType !== callerType && !msg.readAt) {
        msg.readAt = new Date();
        didMarkRead = true;
      }
    });
    if (didMarkRead) await chat.save();

    return res.json({
      success: true,
      chat,
      booking: {
        _id: booking._id,
        status: booking.status,
        bookingType: booking.bookingType,
        serviceDetails: booking.serviceDetails,
        pickupLocation: booking.pickupLocation,
        estimatedPrice: booking.estimatedPrice,
        scheduledTime: booking.scheduledTime,
        userId: booking.userId,
        sellerId: booking.sellerId,
      },
    });
  } catch (error) {
    console.error("getOrCreateChat error:", error);
    return res.status(500).json({ success: false, message: "Failed to load chat." });
  }
};

// =========================================================================
// SEND A MESSAGE (REST fallback — primary delivery via Socket.IO)
// =========================================================================
exports.sendMessage = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: "Message text is required." });
    }

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID." });
    }

    const callerId = req.user?.id || req.seller?.id;
    const callerType = req.user ? "user" : "seller";

    const chat = await Chat.findOne({ bookingId });
    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat thread not found. Open the chat first." });
    }

    // Verify caller belongs to this chat
    const isParty =
      (callerType === "user" && String(chat.userId) === String(callerId)) ||
      (callerType === "seller" && String(chat.sellerId) === String(callerId));

    if (!isParty) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    const newMessage = {
      senderId: callerId,
      senderType: callerType,
      text: text.trim(),
    };

    chat.messages.push(newMessage);
    chat.lastMessage = text.trim().slice(0, 100);
    chat.lastMessageAt = new Date();
    await chat.save();

    const savedMsg = chat.messages[chat.messages.length - 1];

    // Emit via socket if available (injected by socket setup)
    const io = req.app.get("io");
    if (io) {
      io.to(`booking_${bookingId}`).emit("new_message", {
        chatId: chat._id,
        bookingId,
        message: savedMsg,
      });
    }

    return res.json({ success: true, message: savedMsg });
  } catch (error) {
    console.error("sendMessage error:", error);
    return res.status(500).json({ success: false, message: "Failed to send message." });
  }
};

// =========================================================================
// GET ALL MESSAGES FOR A CHAT (with pagination)
// =========================================================================
exports.getMessages = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID." });
    }

    const callerId = req.user?.id || req.seller?.id;
    const callerType = req.user ? "user" : "seller";

    const chat = await Chat.findOne({ bookingId });
    if (!chat) {
      return res.json({ success: true, messages: [], chatId: null });
    }

    const isParty =
      (callerType === "user" && String(chat.userId) === String(callerId)) ||
      (callerType === "seller" && String(chat.sellerId) === String(callerId));

    if (!isParty) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    // Mark incoming messages as read
    let didMark = false;
    chat.messages.forEach((msg) => {
      if (msg.senderType !== callerType && !msg.readAt) {
        msg.readAt = new Date();
        didMark = true;
      }
    });
    if (didMark) await chat.save();

    // Paginate — newest last
    const total = chat.messages.length;
    const start = Math.max(0, total - page * limit);
    const end = total - (page - 1) * limit;
    const messages = chat.messages.slice(start, end);

    return res.json({
      success: true,
      chatId: chat._id,
      messages,
      total,
      page,
      hasMore: start > 0,
    });
  } catch (error) {
    console.error("getMessages error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch messages." });
  }
};

// =========================================================================
// MARK MESSAGES READ
// =========================================================================
exports.markRead = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const callerId = req.user?.id || req.seller?.id;
    const callerType = req.user ? "user" : "seller";

    const chat = await Chat.findOne({ bookingId });
    if (!chat) return res.json({ success: true });

    chat.messages.forEach((msg) => {
      if (msg.senderType !== callerType && !msg.readAt) {
        msg.readAt = new Date();
      }
    });
    await chat.save();

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to mark as read." });
  }
};
