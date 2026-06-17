const { Server } = require("socket.io");

let io = null;

// Call this once from server.js after creating your http server:
//   const httpServer = http.createServer(app);
//   initSocket(httpServer);
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    // Seller app calls: socket.emit('register_seller', sellerId)
    socket.on("register_seller", (sellerId) => {
      if (sellerId) socket.join(`seller_${sellerId}`);
    });

    // Customer app calls: socket.emit('register_user', userId)
    socket.on("register_user", (userId) => {
      if (userId) socket.join(`user_${userId}`);
    });

    socket.on("disconnect", () => {});
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized. Call initSocket(httpServer) first.");
  }
  return io;
};

module.exports = { initSocket, getIO };
