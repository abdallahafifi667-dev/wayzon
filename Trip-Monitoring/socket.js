const { Server } = require("socket.io");
const { authenticateSocket } = require("./middlewares/socketAuth");
const tripEventEmitter = require("./services/tripEventEmitter");

let io;
const userSocketMap = new Map();
const adminSockets = new Set();
const MAX_CONCURRENT_CONNECTIONS = parseInt(
  process.env.MAX_CONCURRENT_CONNECTIONS || "10000",
  10,
);

const setupSocket = (server) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    let userId = null;

    try {
      userId = authenticateSocket(socket);
      if (!userId) {
        socket.disconnect(true);
        return;
      }

      if (userSocketMap.size >= MAX_CONCURRENT_CONNECTIONS) {
        console.warn("Max connections reached");
        socket.emit("error", "Server at maximum capacity");
        socket.disconnect(true);
        return;
      }

      userSocketMap.set(userId, socket.id);
      console.log(`User ${userId} connected (Socket: ${socket.id})`);

      io.emit("onlineUsers", Array.from(userSocketMap.keys()));
      socket.emit("connected", { userId, socketId: socket.id });

      socket.on("register_admin", () => {
        adminSockets.add(socket.id);
        console.log(`Admin registered: ${socket.id}`);
      });

      tripEventEmitter.on("location_update", (data) => {
        socket.emit("location_update", data);
      });
      tripEventEmitter.on("safety_alert", (data) => {
        socket.emit("safety_alert", data);
      });
      tripEventEmitter.on("distance_warning", (data) => {
        socket.emit("distance_warning", data);
      });
    } catch (error) {
      console.error("Socket authentication error:", error.message);
      socket.disconnect(true);
      return;
    }

    socket.on("disconnect", (reason) => {
      if (userId) {
        userSocketMap.delete(userId);
        adminSockets.delete(socket.id);
        console.log(`User ${userId} disconnected (Reason: ${reason})`);
        io.emit("onlineUsers", Array.from(userSocketMap.keys()));
      }
    });
  });
};

const getReceiverSocketId = (userId) => {
  return userSocketMap.get(userId);
};

const getIo = () => {
  if (!io) {
    throw new Error(
      "Socket.io has not been initialized. Call setupSocket() first.",
    );
  }
  return io;
};

module.exports = {
  setupSocket,
  getReceiverSocketId,
  getIo,
  userSocketMap,
  adminSockets,
};
