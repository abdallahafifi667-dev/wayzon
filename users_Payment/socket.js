const { Server } = require("socket.io");
const { verifyAndDecryptToken } = require("./middlewares/genarattokenandcookies");

let io;
const adminSockets = new Set();

const setupSocket = (server) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  io = new Server(server, {
    cors: {
      origin: "*", 
      methods: ["GET", "POST"]
    },
  });

  // Socket Authentication Middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) {
        return next(new Error("Authentication error: No token provided"));
      }

      const decoded = await verifyAndDecryptToken(token);
      if (!decoded || !decoded.id) {
        return next(new Error("Authentication error: Invalid token"));
      }
      
      // Attach the verified user payload to the socket
      socket.user = decoded;
      next();
    } catch (err) {
      console.error("Socket authentication failed:", err.message);
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`New socket connection: ${socket.id}, User ID: ${socket.user.id}`);
    
    // Automatically join the room with their own user ID to receive direct messages
    socket.join(socket.user.id.toString());
    
    // Role based rooms if necessary
    if (socket.user.role === "admin") {
      socket.join("support_admins");
    }

    socket.on("register_admin", () => {
      adminSockets.add(socket.id);
      console.log(`Admin registered: ${socket.id}`);
    });

    socket.on("disconnect", (reason) => {
      adminSockets.delete(socket.id);
      console.log(`Socket disconnected: ${socket.id} (Reason: ${reason})`);
    });
  });
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
  getIo,
  adminSockets,
};
