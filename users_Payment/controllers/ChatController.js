const { getOrderModel } = require("../models/order.models");
const Order = getOrderModel();
const { getChatModel } = require("../models/Chat.models");
const Chat = getChatModel();
const { getRtcConfig } = require("../config/rtc");
const {
  validateSendMessage,
  formatValidationErrors,
} = require("../validators/ChatValidator");
const { logUserAction } = require("../util/auditLogger");

async function getActiveOrder(userId1, userId2) {
  return await Order.findOne({
    $or: [
      { normal: userId1, guide: userId2 },
      { normal: userId2, guide: userId1 },
    ],
    status: { $in: ["confirmed", "Gathering_time", "in_progress", "started"] },
  });
}

/**
 * @desc    Send a chat message
 * @route   POST /api/chat/send
 * @access  Private
 */
exports.sendMessage = async (req, res) => {
  try {
    const from = req.user._id;
    const { error, value } = validateSendMessage(req.body);

    if (error) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatValidationErrors(error),
        code: "VALIDATION_ERROR",
      });
    }

    const { to, message, orderId } = value;

    const order = await getActiveOrder(from, to);
    if (!order) {
      return res.status(403).json({
        error: "No active order between the two parties",
        code: "NO_ACTIVE_ORDER",
      });
    }

    if (order._id.toString() !== orderId) {
      logUserAction({
        user: from,
        ip: req.ip,
        action: "sendMessage",
        details: {
          orderId,
          activeOrderId: order._id,
        },
      });
      return res.status(403).json({
        error: "Order ID does not match active order",
        code: "ORDER_MISMATCH",
      });
    }

    const chatMsg = await Chat.create({
      from,
      to,
      message,
      orderId: order._id,
      messageType: "text",
      idempotencyKey: req.headers["x-idempotency-key"],
    });

    await chatMsg.populate("from", "username avatar");

    const io = req.app.get("io");
    if (io) {
      io.to(to.toString()).emit("newMessage", {
        _id: chatMsg._id,
        from: chatMsg.from,
        message: chatMsg.message,
        orderId: chatMsg.orderId,
        timestamp: chatMsg.createdAt,
        messageType: "text",
      });
    }

    logUserAction({
      user: from,
      ip: req.ip,
      action: "sendMessage",
      details: {
        orderId,
      },
    });

    res.json({
      success: true,
      message: chatMsg,
      timestamp: chatMsg.createdAt,
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "sendMessage",
      details: {
        orderId: req.body?.orderId,
        error: error.message,
      },
    });
    res.status(500).json({
      error: "Failed to send message",
      code: "SEND_MESSAGE_ERROR",
      errorId: req.correlationId,
    });
  }
};

/**
 * @desc    Get messages between two users
 * @route   GET /api/chat/messages/:userId
 * @access  Private
 */
exports.getMessages = async (req, res) => {
  try {
    const { userId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const me = req.user._id;

    if (page < 1 || limit < 1 || limit > 100) {
      return res.status(400).json({
        error: "Invalid pagination parameters",
        code: "INVALID_PAGINATION",
        details: "page >= 1, 1 <= limit <= 100",
      });
    }

    const order = await getActiveOrder(me, userId);
    if (!order) {
      return res.status(403).json({
        error: "No active order between the two parties",
        code: "NO_ACTIVE_ORDER",
      });
    }

    const skip = (page - 1) * limit;

    const messages = await Chat.find({
      orderId: order._id,
      $or: [
        { from: me, to: userId },
        { from: userId, to: me },
      ],
    })
      .populate("from", "username profilePicture")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const total = await Chat.countDocuments({
      orderId: order._id,
      $or: [
        { from: me, to: userId },
        { from: userId, to: me },
      ],
    });

    await Chat.updateMany(
      {
        orderId: order._id,
        to: me,
        isRead: false,
      },
      { isRead: true, readAt: new Date() },
    );

    logUserAction({
      user: me,
      ip: req.ip,
      action: "getMessages",
      details: {
        orderId,
        page,
        limit,
        total,
        messagesCount: messages.length,
      },
    });

    res.json({
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
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "getMessages",
      details: {
        targetUserId: req.params?.userId,
        error: error.message,
      },
    });
    res.status(500).json({
      error: "Failed to retrieve messages",
      code: "GET_MESSAGES_ERROR",
      errorId: req.correlationId,
    });
  }
};

/**
 * @desc    Get RTC configuration
 * @route   GET /api/chat/rtc/config
 * @access  Private
 */
exports.getRTCConfig = async (req, res) => {
  try {
    const config = getRtcConfig();
    res.json({
      success: true,
      config,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "getRTCConfig",
      details: {
        error: error.message,
      },
    });
    res.status(500).json({
      error: "Failed to get RTC configuration",
      code: "RTC_CONFIG_ERROR",
      errorId: req.correlationId,
    });
  }
};

/**
 * @desc    Start a call
 * @route   POST /api/chat/call/start
 * @access  Private
 */
exports.startCall = async (req, res) => {
  try {
    const { to } = req.body;
    const from = req.user._id;

    if (!to) {
      return res.status(400).json({
        error: "Recipient ID is required",
        code: "MISSING_RECIPIENT",
      });
    }

    const order = await getActiveOrder(from, to);
    if (!order) {
      return res.status(403).json({
        error: "No active order between the two parties",
        code: "NO_ACTIVE_ORDER",
      });
    }

    const io = req.app.get("io");
    if (io) {
      io.to(to.toString()).emit("incomingCall", {
        from,
        fromName: req.user.username,
        orderId: order._id,
        peerId: req.body.peerId, // Caller's Peer ID
        rtcConfig: getRtcConfig(),
        timestamp: new Date().toISOString(),
      });
    }

    logUserAction({
      user: from,
      ip: req.ip,
      action: "startCall",
      details: {
        to,
        orderId: order._id,
      },
    });

    res.json({
      success: true,
      message: "Call request sent successfully",
      rtcConfig: getRtcConfig(),
      callId: order._id,
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "startCall",
      details: {
        to: req.body?.to,
        error: error.message,
      },
    });
    res.status(500).json({
      error: "Failed to start call",
      code: "START_CALL_ERROR",
      errorId: req.correlationId,
    });
  }
};

/**
 * @desc    Accept a call
 * @route   POST /api/chat/call/accept
 * @access  Private
 */
exports.acceptCall = async (req, res) => {
  try {
    const { from, offer } = req.body;
    const to = req.user._id;

    if (!from || !offer) {
      return res.status(400).json({
        error: "Missing required fields (from, offer)",
        code: "MISSING_FIELDS",
      });
    }

    const order = await getActiveOrder(from, to);
    if (!order) {
      return res.status(403).json({
        error: "No active order between the two parties",
        code: "NO_ACTIVE_ORDER",
      });
    }

    const io = req.app.get("io");
    if (io) {
      io.to(from.toString()).emit("callAccepted", {
        to,
        toName: req.user.username,
        peerId: req.body.peerId, // Callee's Peer ID
        orderId: order._id,
        timestamp: new Date().toISOString(),
      });
    }

    logUserAction({
      user: from,
      ip: req.ip,
      action: "acceptCall",
      details: {
        to,
        orderId: order._id,
      },
    });

    res.json({
      success: true,
      message: "Call accepted successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "acceptCall",
      details: {
        from: req.body?.from,
        error: error.message,
      },
    });
    res.status(500).json({
      error: "Failed to accept call",
      code: "ACCEPT_CALL_ERROR",
      errorId: req.correlationId,
    });
  }
};

/**
 * @desc    Reject a call
 * @route   POST /api/chat/call/reject
 * @access  Private
 */
exports.rejectCall = async (req, res) => {
  try {
    const { from, reason } = req.body;
    const to = req.user._id;

    if (!from) {
      return res.status(400).json({
        error: "Caller ID is required",
        code: "MISSING_CALLER",
      });
    }

    const io = req.app.get("io");
    if (io) {
      io.to(from.toString()).emit("callRejected", {
        to,
        reason: reason || "User rejected the call",
        timestamp: new Date().toISOString(),
      });
    }

    logUserAction({
      user: from,
      ip: req.ip,
      action: "rejectCall",
      details: {
        to,
        reason: reason || "User rejected the call",
      },
    });

    res.json({
      success: true,
      message: "Call rejected successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "rejectCall",
      details: {
        from: req.body?.from,
        reason: req.body?.reason,
        error: error.message,
      },
    });
    res.status(500).json({
      error: "Failed to reject call",
      code: "REJECT_CALL_ERROR",
      errorId: req.correlationId,
    });
  }
};

/**
 * @desc    End a call
 * @route   POST /api/chat/call/end
 * @access  Private
 */
exports.endCall = async (req, res) => {
  try {
    const { to } = req.body;
    const from = req.user._id;

    if (!to) {
      return res.status(400).json({
        error: "Recipient ID is required",
        code: "MISSING_RECIPIENT",
      });
    }

    const io = req.app.get("io");
    if (io) {
      io.to(to.toString()).emit("callEnded", {
        from,
        timestamp: new Date().toISOString(),
      });
    }

    logUserAction({
      user: from,
      ip: req.ip,
      action: "endCall",
      details: {
        to,
        timestamp: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      message: "Call ended successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "endCall",
      details: {
        to: req.body?.to,
        timestamp: new Date().toISOString(),
        error: error.message,
      },
    });
    res.status(500).json({
      error: "Failed to end call",
      code: "END_CALL_ERROR",
      errorId: req.correlationId,
    });
  }
};
