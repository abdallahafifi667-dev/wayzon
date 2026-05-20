const { getSupportSessionModel, getSupportMessageModel } = require("../models/Support.models");
const SupportSession = getSupportSessionModel();
const SupportMessage = getSupportMessageModel();

const { getUserModel } = require("../models/users.models");
const User = getUserModel();

const NotificationService = require("./Notification/notificationService");
const {
  validateSendMessage,
  validateSendMessageAdmin,
  formatValidationErrors,
} = require("../validators/SupportValidator");

const { logUserAction } = require("../util/auditLogger");

let isSocketInitialized = false;

const initSupportSocket = (io) => {
  if (!io) return;
  io.on("connection", (socket) => {
    socket.on("join_support", (userId) => {
      if (userId) {
        socket.join(userId.toString());
      }
    });

    socket.on("join_support_admin", () => {
      socket.join("support_admins");
    });
  });
};

const lazyInitSocket = (req) => {
  if (isSocketInitialized) return;
  const io = req.app.get("io");
  if (io) {
    initSupportSocket(io);
    isSocketInitialized = true;
  }
};

exports.sendSupportMessageUser = async (req, res) => {
  lazyInitSocket(req);
  const userId = req.user._id;

  try {
    const { error, value } = validateSendMessage(req.body);
    if (error) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatValidationErrors(error),
        code: "VALIDATION_ERROR",
      });
    }

    const { message, messageType } = value;

    const chatMsg = await SupportMessage.create({
      user: userId,
      sender: "user",
      message,
      messageType: messageType || "text",
    });

    const session = await SupportSession.findOneAndUpdate(
      { user: userId },
      {
        status: "pending",
        lastMessage: messageType === "text" ? message : `[Sent an ${messageType}]`,
        lastMessageType: messageType || "text",
        lastMessageAt: new Date(),
        $inc: { unreadCountAdmin: 1 },
      },
      { upsert: true, new: true }
    );

    await chatMsg.populate("user", "username avatar role");

    const io = req.app.get("io");
    if (io) {
      io.to(userId.toString()).emit("newSupportMessage", chatMsg);
      io.to("support_admins").emit("newSupportMessage", chatMsg);
      io.to("support_admins").emit("supportSessionUpdated", session);
    }

    try {
      const admins = await User.find({ role: "admin" }).select("fcmTokens").lean();
      const adminTokens = admins.flatMap(adm => adm.fcmTokens || []).filter(token => !!token);
      
      if (adminTokens.length > 0) {
        await NotificationService.sendToMultipleDevices(
          adminTokens,
          `Support Request: ${req.user.username}`,
          messageType === "text" ? message : `Sent an ${messageType} attachment`,
          {
            type: "support_message",
            userId: userId.toString(),
          }
        );
      }
    } catch (notifErr) {
      console.error(notifErr);
    }

    logUserAction({
      user: userId,
      ip: req.ip,
      action: "sendSupportMessageUser",
      details: { messageType },
    });

    res.status(201).json({
      success: true,
      message: chatMsg,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to send support message" });
  }
};

exports.getSupportMessagesUser = async (req, res) => {
  lazyInitSocket(req);
  const userId = req.user._id;

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 40;
    const skip = (page - 1) * limit;

    const messages = await SupportMessage.find({ user: userId })
      .populate("user", "username avatar role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await SupportMessage.countDocuments({ user: userId });

    await SupportMessage.updateMany(
      { user: userId, sender: "admin", isRead: false },
      { isRead: true, readAt: new Date() }
    );

    await SupportSession.findOneAndUpdate(
      { user: userId },
      { unreadCountUser: 0 }
    );

    res.status(200).json({
      success: true,
      messages: messages.reverse(),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        hasMore: page < Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch support messages" });
  }
};

exports.getSupportSessionsAdmin = async (req, res) => {
  lazyInitSocket(req);
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { status } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const sessions = await SupportSession.find(filter)
      .populate("user", "username email phone avatar role")
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await SupportSession.countDocuments(filter);

    res.status(200).json({
      success: true,
      sessions,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        hasMore: page < Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch support sessions" });
  }
};

exports.getSupportMessagesAdmin = async (req, res) => {
  lazyInitSocket(req);
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }

  const { userId } = req.params;

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 40;
    const skip = (page - 1) * limit;

    const messages = await SupportMessage.find({ user: userId })
      .populate("user", "username email phone avatar role")
      .populate("adminId", "username avatar")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await SupportMessage.countDocuments({ user: userId });

    await SupportMessage.updateMany(
      { user: userId, sender: "user", isRead: false },
      { isRead: true, readAt: new Date() }
    );

    await SupportSession.findOneAndUpdate(
      { user: userId },
      { unreadCountAdmin: 0 }
    );

    res.status(200).json({
      success: true,
      messages: messages.reverse(),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        hasMore: page < Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages for admin" });
  }
};

exports.sendSupportMessageAdmin = async (req, res) => {
  lazyInitSocket(req);
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }

  try {
    const { error, value } = validateSendMessageAdmin(req.body);
    if (error) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatValidationErrors(error),
        code: "VALIDATION_ERROR",
      });
    }

    const { userId, message, messageType } = value;
    const adminId = req.user._id;

    const chatMsg = await SupportMessage.create({
      user: userId,
      sender: "admin",
      adminId,
      message,
      messageType: messageType || "text",
    });

    const session = await SupportSession.findOneAndUpdate(
      { user: userId },
      {
        status: "in-progress",
        lastMessage: messageType === "text" ? message : `[Sent an ${messageType}]`,
        lastMessageType: messageType || "text",
        lastMessageAt: new Date(),
        unreadCountAdmin: 0,
        $inc: { unreadCountUser: 1 },
      },
      { upsert: true, new: true }
    );

    await chatMsg.populate("user", "username avatar role");
    await chatMsg.populate("adminId", "username avatar");

    const io = req.app.get("io");
    if (io) {
      io.to(userId.toString()).emit("newSupportMessage", chatMsg);
      io.to("support_admins").emit("newSupportMessage", chatMsg);
      io.to("support_admins").emit("supportSessionUpdated", session);
    }

    try {
      const targetUser = await User.findById(userId).select("fcmTokens").lean();
      const userTokens = targetUser && targetUser.fcmTokens ? targetUser.fcmTokens.filter(t => !!t) : [];

      if (userTokens.length > 0) {
        await NotificationService.sendToMultipleDevices(
          userTokens,
          "Wayzon Support Team",
          messageType === "text" ? message : `Sent an ${messageType} attachment`,
          {
            type: "support_reply",
            adminId: adminId.toString(),
          }
        );
      }
    } catch (notifErr) {
      console.error(notifErr);
    }

    logUserAction({
      user: adminId,
      ip: req.ip,
      action: "sendSupportMessageAdmin",
      details: { userId, messageType },
    });

    res.status(201).json({
      success: true,
      message: chatMsg,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to send admin support reply" });
  }
};

exports.resolveSupportSessionAdmin = async (req, res) => {
  lazyInitSocket(req);
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }

  const { userId } = req.params;

  try {
    const session = await SupportSession.findOneAndUpdate(
      { user: userId },
      { status: "resolved" },
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: "Support session not found for this user" });
    }

    const io = req.app.get("io");
    if (io) {
      io.to(userId.toString()).emit("supportSessionResolved", { userId, status: "resolved" });
      io.to("support_admins").emit("supportSessionUpdated", session);
    }

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "resolveSupportSessionAdmin",
      details: { userId },
    });

    res.status(200).json({
      success: true,
      message: "Support chat session marked as resolved",
      session,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to resolve support session" });
  }
};

module.exports.initSupportSocket = initSupportSocket;
