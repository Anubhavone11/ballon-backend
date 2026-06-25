// socket/socketSetup.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Chat = require("../models/Chat");

/**
 * Authenticate a socket connection.
 * Accepts both user JWTs and seller JWTs.
 */
const authenticateSocket = (token) => {
  if (!token) return null;

  // Try user token
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key");
    if (!decoded.isSeller) return { id: decoded.id, type: "user", name: decoded.name };
  } catch (_) {}

  // Try seller token
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_SELLER || "your-secret-key");
    if (decoded.isSeller) return { id: decoded.id, type: "seller", name: decoded.name };
  } catch (_) {}

  return null;
};

// REMOVED 'app' from the parameters here
const initSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // -----------------------------------------------------------------------
  // Auth middleware for socket connections
  // -----------------------------------------------------------------------
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;

    const principal = authenticateSocket(token);
    if (!principal) {
      return next(new Error("Socket authentication failed."));
    }

    socket.principal = principal;
    next();
  });

  // -----------------------------------------------------------------------
  // Connection handler
  // -----------------------------------------------------------------------
  io.on("connection", (socket) => {
    const { id: callerId, type: callerType, name: callerName } = socket.principal;
    console.log(`🔌 Socket connected | ${callerType}: ${callerName} (${callerId})`);

    // ---- JOIN a booking chat room ----
    socket.on("join_booking_chat", async ({ bookingId }) => {
      try {
        const chat = await Chat.findOne({ bookingId });
        if (!chat) {
          socket.emit("error_event", { message: "Chat not found for this booking." });
          return;
        }

        // Verify the caller is a party
        const isParty =
          (callerType === "user" && String(chat.userId) === String(callerId)) ||
          (callerType === "seller" && String(chat.sellerId) === String(callerId));

        if (!isParty) {
          socket.emit("error_event", { message: "Not authorized for this chat." });
          return;
        }

        const room = `booking_${bookingId}`;
        socket.join(room);
        socket.currentRoom = room;
        console.log(`📨 ${callerType} ${callerName} joined room ${room}`);

        // Confirm join
        socket.emit("joined_chat", { bookingId, room });
      } catch (err) {
        console.error("join_booking_chat error:", err);
        socket.emit("error_event", { message: "Failed to join chat room." });
      }
    });

    // ---- SEND a message via socket ----
    socket.on("send_message", async ({ bookingId, text }) => {
      try {
        if (!text?.trim()) return;

        const chat = await Chat.findOne({ bookingId });
        if (!chat) {
          socket.emit("error_event", { message: "Chat not found." });
          return;
        }

        const isParty =
          (callerType === "user" && String(chat.userId) === String(callerId)) ||
          (callerType === "seller" && String(chat.sellerId) === String(callerId));

        if (!isParty) {
          socket.emit("error_event", { message: "Not authorized." });
          return;
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

        // Broadcast to the booking room (both parties)
        const room = `booking_${bookingId}`;
        io.to(room).emit("new_message", {
          chatId: chat._id,
          bookingId,
          message: savedMsg,
        });
      } catch (err) {
        console.error("send_message socket error:", err);
        socket.emit("error_event", { message: "Failed to deliver message." });
      }
    });

    // ---- TYPING indicator ----
    socket.on("typing", ({ bookingId }) => {
      socket.to(`booking_${bookingId}`).emit("user_typing", {
        senderId: callerId,
        senderType: callerType,
      });
    });

    socket.on("stop_typing", ({ bookingId }) => {
      socket.to(`booking_${bookingId}`).emit("user_stop_typing", {
        senderId: callerId,
      });
    });

    // ---- LEAVE room ----
    socket.on("leave_booking_chat", ({ bookingId }) => {
      const room = `booking_${bookingId}`;
      socket.leave(room);
    });

    socket.on("disconnect", () => {
      console.log(`🔌 Socket disconnected | ${callerType}: ${callerName}`);
    });
  });

  return io;
};

module.exports = { initSocket };