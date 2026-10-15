// socket/socketSetup.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Chat = require("../models/Chat");
const { emit } = require("../notifications");

let io = null;

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

const initSocket = (server) => {
  io = new Server(server, {
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

    // ---- Personal rooms (used for job offers now, live customer updates later) ----
    if (callerType === "seller") {
      socket.join(`seller:${callerId}`);

      // If a job is ringing for this seller right now (reconnect, or they tapped
      // the push), show it again with the time that is really left.
      try {
        const { getPendingOffer } = require("../controllers/bookingController");
        const pending = getPendingOffer(callerId);
        if (pending) socket.emit("booking:offer", pending);
      } catch (e) {
        console.error("pending offer replay error:", e.message);
      }
    } else {
      socket.join(`user:${callerId}`);
    }

    // ---- JOB OFFER: seller accepts (the "answer the call" button) ----
    socket.on("offer:accept", async ({ bookingId } = {}, ack) => {
      if (callerType !== "seller") return ack?.({ ok: false, message: "Not allowed." });
      // lazy require avoids a circular import with bookingController
      const { acceptBookingCore } = require("../controllers/bookingController");
      try {
        // sellerId comes from the verified token, never from the client
        const { booking } = await acceptBookingCore(bookingId, callerId);
        ack?.({ ok: true, booking });
      } catch (err) {
        ack?.({ ok: false, message: err.code ? err.message : "Could not accept this booking." });
      }
    });

    // ---- JOB OFFER: seller declines ----
    socket.on("offer:decline", async ({ bookingId } = {}, ack) => {
      if (callerType !== "seller") return ack?.({ ok: false });
      const { declineBookingCore } = require("../controllers/bookingController");
      await declineBookingCore(bookingId, callerId).catch(() => {});
      ack?.({ ok: true });
    });

    // ---- JOIN a booking chat room ----
    socket.on("join_booking_chat", async ({ bookingId }) => {
      try {
        const chat = await Chat.findOne({ bookingId });
        if (!chat) {
          socket.emit("error_event", { message: "Chat not found for this booking." });
          return;
        }

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

        const room = `booking_${bookingId}`;
        io.to(room).emit("new_message", {
          chatId: chat._id,
          bookingId,
          message: savedMsg,
        });

        try {
          const recipientType = callerType === "user" ? "seller" : "user";
          const recipientId = callerType === "user" ? chat.sellerId : chat.userId;

          const socketsInRoom = await io.in(room).fetchSockets();
          const recipientInRoom = socketsInRoom.some(
            (s) =>
              s.principal?.type === recipientType &&
              String(s.principal.id) === String(recipientId)
          );

          if (!recipientInRoom) {
            emit("chat.message", {
              chat,
              bookingId,
              senderType: callerType,
              senderName: callerName,
              text: newMessage.text,
            });
          }
        } catch (pushErr) {
          console.error("chat push error:", pushErr.message);
        }
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
      socket.leave(`booking_${bookingId}`);
    });

    socket.on("disconnect", () => {
      console.log(`🔌 Socket disconnected | ${callerType}: ${callerName}`);
    });
  });

  return io;
};

// ─── Helpers used by other files ─────────────────────────────────────────────
const emitToSeller = (sellerId, event, payload) => {
  io?.to(`seller:${sellerId}`).emit(event, payload);
};
const emitToSellers = (sellerIds, event, payload) => {
  (sellerIds || []).forEach((id) => emitToSeller(id, event, payload));
};
const emitToUser = (userId, event, payload) => {
  io?.to(`user:${userId}`).emit(event, payload);
};
const isSellerOnline = (sellerId) =>
  (io?.sockets.adapter.rooms.get(`seller:${sellerId}`)?.size || 0) > 0;

module.exports = { initSocket, emitToSeller, emitToSellers, emitToUser, isSellerOnline };