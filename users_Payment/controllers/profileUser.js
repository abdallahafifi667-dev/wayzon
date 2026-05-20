const asyncHandler = require("express-async-handler");
const xss = require("xss");
const {
  generateTokenAndSend,
} = require("../middlewares/genarattokenandcookies");
const {
  validateProfileUpdate,
  formatValidationErrors: formatProfileValidationErrors,
} = require("../validators/ProfileValidator");
const { sendEvent } = require("../config/kafka");
const { getOrderModel } = require("../models/order.models");
const Order = getOrderModel();
const { getUserModel } = require("../models/users.models");
const User = getUserModel();
const { logUserAction } = require("../util/auditLogger");

if (!process.env.JWT_SECRET) {
  throw new Error(
    "JWT_SECRET environment variable is not defined. The server cannot start without it.",
  );
}

/**
 * @desc    Get user profile
 * @route   GET /api/user/profile/:id
 * @access  Private
 */
exports.getUserProfile = asyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password -email");

    if (!user) {
      logUserAction({
        user: req.user?._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "getUserProfile",
          subject: "getUserProfile",
          targetUserId: req.params.id,
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getUserProfile",
        subject: "getUserProfile",
        targetUserId: req.params.id,
      },
    });

    res.status(200).json(user);
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getUserProfile",
        subject: "getUserProfile",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
});

/**
 * @desc    Update user profile
 * @route   PUT /api/user/profile/:id
 * @access  Private
 */
exports.updateUserProfile = asyncHandler(async (req, res) => {
  try {
    let data = {
      username: req.body.username ? xss(req.body.username) : undefined,
      phone: req.body.phone ? xss(req.body.phone) : undefined,
      description: req.body.description ? xss(req.body.description) : undefined,
      gender: req.body.gender ? xss(req.body.gender) : undefined,
      Address: req.body.Address ? xss(req.body.Address) : undefined,
    };

    // Remove undefined fields to avoid overwriting with null if not provided
    Object.keys(data).forEach(key => data[key] === undefined && delete data[key]);

    const { error } = validateProfileUpdate(data);
    if (error) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateUserProfile",
          subject: "updateUserProfile",
          error: "Validation error",
        },
      });
      return res
        .status(400)
        .json({ error: formatProfileValidationErrors(error) });
    }
    if (
      !(
        req.user &&
        (req.user._id.toString() === req.params.id || req.user.role === "admin")
      )
    ) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateUserProfile",
          subject: "updateUserProfile",
          targetUserId: req.params.id,
          error: "Unauthorized to update profile",
        },
      });
      return res
        .status(403)
        .json({ message: "Unauthorized to update profile" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateUserProfile",
          subject: "updateUserProfile",
          targetUserId: req.params.id,
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    try {
      await sendEvent("profile-update", {
        userId: req.params.id,
        ...data,
        timestamp: new Date(),
      });

      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateUserProfile",
          subject: "updateUserProfile",
          targetUserId: req.params.id,
          updateMethod: "kafka",
        },
      });

      generateTokenAndSend(user, res);
      res.status(200).json({
        success: true,
        message: "Profile update sent, changes will be applied shortly",
        userId: user._id,
      });
    } catch (kafkaError) {
      const updatedUser = await User.findByIdAndUpdate(
        req.params.id,
        { $set: data },
        { new: true },
      ).select("-password -email");

      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateUserProfile",
          subject: "updateUserProfile",
          targetUserId: req.params.id,
          updateMethod: "sync_fallback",
        },
      });

      generateTokenAndSend(updatedUser, res);
      res.status(200).json(updatedUser);
    }
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "updateUserProfile",
        subject: "updateUserProfile",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
});

/**
 * @desc    Get user orders (completed)
 * @route   GET /api/user/orders/completed
 * @access  Private
 */
exports.getUserOrders = asyncHandler(async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 10, status = "completed" } = req.query;
    const skip = (page - 1) * limit;

    const filter = {
      $or: [{ normal: userId }, { guide: userId }],
      status: status,
    };

    const [orders, totalOrders] = await Promise.all([
      Order.find(filter)
        .populate("normal", "username avatar")
        .populate("guide", "username avatar")
        .skip(skip)
        .limit(Number(limit))
        .sort({ createdAt: -1 })
        .lean(),
      Order.countDocuments(filter),
    ]);

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getUserOrders",
        subject: "getUserOrders",
        ordersCount: orders?.length ?? 0,
        status: status,
      },
    });

    res.status(200).json({
      total: totalOrders,
      currentPage: Number(page),
      totalPages: Math.ceil(totalOrders / limit) || 0,
      orders: orders || [],
    });
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getUserOrders",
        subject: "getUserOrders",
        error: error.message,
      },
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * @desc    Get user order by ID
 * @route   GET /api/user/orders/completed/:id
 * @access  Private
 */
exports.getUserOrderById = asyncHandler(async (req, res) => {
  try {
    const userId = req.user._id;
    const orderId = req.params.id;

    const order = await Order.findOne({
      _id: orderId,
      $or: [{ normal: userId }, { guide: userId }],
    })
      .populate("normal", "username avatar phone")
      .populate("guide", "username avatar phone")
      .lean();

    if (!order) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "getUserOrderById",
          subject: "getUserOrderById",
          orderId: orderId,
          error: "Order not found or not accessible",
        },
      });
      return res
        .status(404)
        .json({ message: "Order not found or not accessible" });
    }

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getUserOrderById",
        subject: "getUserOrderById",
        orderId: orderId,
        orderStatus: order.status,
      },
    });

    res.status(200).json(order);
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getUserOrderById",
        subject: "getUserOrderById",
        orderId: req.params.id,
        error: error.message,
      },
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * @desc    Get user transportation info
 * @route   GET /api/user/transportation/:id
 * @access  Private
 */
exports.getTransportation = asyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("transportation");

    if (!user) {
      logUserAction({
        user: req.user?._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "getTransportation",
          targetUserId: req.params.id,
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getTransportation",
        targetUserId: req.params.id,
        hasVehicle: user.transportation?.hasVehicle,
      },
    });

    res.status(200).json({
      transportation: user.transportation || {
        hasVehicle: false,
        vehicleType: "none",
        description: null,
      },
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getTransportation",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({
        message: "Error fetching transportation info",
        error: error.message,
      });
  }
});

/**
 * @desc    Update user transportation info
 * @route   PUT /api/user/transportation/:id
 * @access  Private
 */
exports.updateTransportation = asyncHandler(async (req, res) => {
  try {
    const { hasVehicle, vehicleType, description } = req.body;
    const userId = req.params.id;

    // Validate user authorization
    if (req.user._id.toString() !== userId) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateTransportation",
          targetUserId: userId,
          error: "Unauthorized - can only update own transportation info",
        },
      });
      return res
        .status(403)
        .json({
          message:
            "Unauthorized - can only update your own transportation info",
        });
    }

    // Validate input
    if (hasVehicle && vehicleType) {
      const validVehicleTypes = ["car", "bus", "none"];
      if (!validVehicleTypes.includes(vehicleType)) {
        logUserAction({
          user: req.user._id,
          ip: req.ip,
          action: "user",
          details: {
            action: "updateTransportation",
            error: "Invalid vehicle type",
          },
        });
        return res.status(400).json({
          message: `Invalid vehicle type. Must be one of: ${validVehicleTypes.join(", ")}`,
        });
      }
    }

    // Validate description length if provided
    if (description && description.length > 500) {
      return res
        .status(400)
        .json({ message: "Description cannot exceed 500 characters" });
    }

    const user = await User.findById(userId);

    if (!user) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateTransportation",
          targetUserId: userId,
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    // Update transportation
    user.transportation = {
      hasVehicle: hasVehicle || false,
      vehicleType: hasVehicle ? vehicleType || "none" : "none",
      description: description ? xss(description) : null,
    };

    await user.save();

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "updateTransportation",
        hasVehicle: user.transportation.hasVehicle,
        vehicleType: user.transportation.vehicleType,
      },
    });

    res.status(200).json({
      message: "Transportation info updated successfully",
      transportation: user.transportation,
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "updateTransportation",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({
        message: "Error updating transportation info",
        error: error.message,
      });
  }
});
