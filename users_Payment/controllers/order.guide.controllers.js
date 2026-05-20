const { getOrderModel } = require("../models/order.models");
const Order = getOrderModel();
const { getUserModel } = require("../models/users.models");
const User = getUserModel();
const asyncHandler = require("express-async-handler");
const { getIo } = require("../socket");
const emailService = require("../util/sendGemail");
const { sendToMultipleDevices } = require("./Notification/notificationService");
const { logUserAction } = require("../util/auditLogger");
const { areTripsConflicting, restoreConflicts } = require("../util/tripUtils");

/**
 * @desc    الحصول على الطلبات لي المرشدين (مرتبة حسب القرب)
 * @route   GET /api/orders/guide
 * @access  خاص (guide)
 */
exports.getOrdersForGuide = asyncHandler(async (req, res) => {
  try {
    const { filter } = req.query;
    const { location, country, languages } = req.user;

    if (!location || !location.coordinates || location.coordinates.length < 2) {
      return res
        .status(200)
        .json({ message: "User location is not specified", orders: [] });
    }

    const guideLanguageNames = (languages || []).map((lang) =>
      lang.name.toLowerCase(),
    );

    if (guideLanguageNames.length === 0) {
      return res.status(200).json({
        message: "You must have at least one language set in your profile",
        orders: [],
      });
    }

    const confirmedOrders = await Order.find({
      guide: req.user._id,
      status: "confirmed",
    }).select("TripDate");

    const excludedDates = confirmedOrders.map(
      (order) => new Date(order.TripDate).toISOString().split("T")[0],
    );

    let distance = 50000;
    const MAX_DISTANCE = 2000000;
    let orders = [];

    while (distance <= MAX_DISTANCE && orders.length === 0) {
      orders = await Order.aggregate([
        {
          $geoNear: {
            near: {
              type: "Point",
              coordinates: [location.coordinates[0], location.coordinates[1]],
            },
            distanceField: "distance",
            spherical: true,
            maxDistance: distance,
            query: {
              serviceType: "with_guide",
              status: { $in: ["open", "bidding"] },
              destinationCountry: country,
              ...(filter === "no_itinerary" && {
                destinationStatus: "undefined",
              }),
              ...(filter === "bidding" && { status: "bidding" }),
              ...(filter === "ready" && {
                destinationStatus: "defined",
                status: "open",
              }),
            },
          },
        },
        {
          $addFields: {
            tripDay: {
              $dateToString: { format: "%Y-%m-%d", date: "$TripDate" },
            },
          },
        },
        {
          $match: {
            tripDay: { $nin: excludedDates },
          },
        },
        { $sort: { distance: 1 } },
        {
          $lookup: {
            from: "users",
            localField: "normal",
            foreignField: "_id",
            as: "touristInfo",
          },
        },
        {
          $unwind: "$touristInfo",
        },
        {
          $addFields: {
            touristLanguageNames: {
              $map: {
                input: { $ifNull: ["$touristInfo.languages", []] },
                as: "lang",
                in: { $toLower: "$$lang.name" },
              },
            },
          },
        },
        {
          $match: {
            touristLanguageNames: {
              $in: guideLanguageNames,
            },
          },
        },
        {
          $project: {
            touristInfo: 0,
            touristLanguageNames: 0,
          },
        },
      ]);

      if (orders.length === 0) {
        distance *= 2;
      }
    }

    if (!orders.length) {
      return res.status(404).json({
        message: "There are no applications available in the geographic area.",
      });
    }

    const populatedOrders = await User.populate(orders, {
      path: "normal",
      select: "username avatar _id",
    });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "getOrdersForGuide",
        subject: "getOrdersForGuide",
        ordersCount: orders.length,
        distance: distance / 1000,
      },
    });

    res.status(200).json({
      message: `Found an order ${orders.length} within the range ${distance / 1000} km`,
      orders: populatedOrders,
    });
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "getOrdersForGuide",
        subject: "getOrdersForGuide",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
});

/**
 * @desc    التقديم علي الطلب
 * @route   patch /api/orders/:id/accept
 * @access  خاص (guide)
 */
exports.acceptOrder = asyncHandler(async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order || (order.status !== "open" && order.status !== "bidding")) {
      res.status(404);
      throw new Error("Order not found or not open for applications");
    }

    if (req.user.role !== "guide") {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "guide",
        details: {
          action: "acceptOrder",
          subject: "acceptOrder",
          orderId: req.params.id,
          error: "Only guides can accept orders",
        },
      });
      return res.status(403).json({ error: "Only guides can accept orders" });
    }

    // Check for conflicting confirmed trips
    const confirmedOrders = await Order.find({
      guide: req.user._id,
      status: "confirmed",
    });

    const hasConflict = confirmedOrders.some((confirmed) =>
      areTripsConflicting(
        confirmed.TripDate,
        confirmed.duration,
        order.TripDate,
        order.duration,
      ),
    );

    if (hasConflict) {
      return res
        .status(400)
        .json({ error: "You have a confirmed trip at this time" });
    }

    if (order.Interested.length >= 25) {
      res.status(400);
      throw new Error(
        "This order already has the maximum number of Interested guides",
      );
    }

    const { proposedPrice, proposedItinerary, description } = req.body;

    if (proposedPrice) {
      const existingOffer = order.offers.find(
        (o) => o.guide.toString() === req.user._id.toString(),
      );
      if (existingOffer) {
        res.status(400);
        throw new Error("You have already submitted an offer for this order");
      }

      order.offers.push({
        guide: req.user._id,
        proposedPrice: parseFloat(proposedPrice),
        proposedItinerary: Array.isArray(proposedItinerary)
          ? proposedItinerary.map((loc) => ({
            type: "Point",
            coordinates: [loc.lng, loc.lat],
          }))
          : [],
        description: description,
        status: "pending",
      });
    }

    if (order.Interested.includes(req.user._id)) {
      if (!proposedPrice) {
        // Only throw if it's not a new offer (avoiding confusion)
        res.status(400);
        throw new Error("You have already accepted this order");
      }
    } else {
      order.Interested.push(req.user._id);
    }

    if (order.Interested.length === 25) {
      order.status = "Submission_closed";
    }

    await order.save();

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "acceptOrder",
        subject: "acceptOrder",
        orderId: order._id,
        interestedCount: order.Interested.length,
      },
    });

    res.status(200).json({ message: "Order accepted successfully" });

    // Removed socket emission

    try {
      const normalUser = await User.findById(order.normal).select(
        "fcmTokens username",
      );
      if (
        normalUser &&
        normalUser.fcmTokens &&
        normalUser.fcmTokens.length > 0
      ) {
        await sendToMultipleDevices(
          normalUser.fcmTokens,
          "New Guide Interested!",
          `${req.user.username} is interested in your trip: ${order.title || "Trip"}`,
          {
            orderId: order._id.toString(),
            type: "guide_interested",
            guideId: req.user._id.toString(),
            guideName: req.user.username,
            tripTitle: order.title || "",
            interestedCount: order.Interested.length,
          },
        );
      }
    } catch (notificationErr) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "guide",
        details: {
          action: "acceptOrder",
          subject: "notification_error",
          error: notificationErr.message,
        },
      });
    }
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "acceptOrder",
        subject: "acceptOrder",
        orderId: req.params.id,
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
});

/**
 * @desc    موافقه الطلب من قبل المرشد
 * @route   PATCH /api/orders/:id/confirm
 * @access  خاص (المرشد)
 */
exports.confirmOrder = asyncHandler(async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order || order.status !== "awaiting_guide_confirmation") {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "guide",
        details: {
          action: "confirmOrder",
          subject: "confirmOrder",
          orderId: req.params.id,
          error: "Order not found or not in progress",
        },
      });
      return res
        .status(404)
        .json({ message: "Order not found or not in progress" });
    }

    if (order.guide?.toString() !== req.user._id.toString()) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "guide",
        details: {
          action: "confirmOrder",
          subject: "confirmOrder",
          orderId: req.params.id,
          error: "Unauthorized to confirm this order",
        },
      });
      return res
        .status(403)
        .json({ message: "You are not authorized to confirm this order" });
    }

    order.status = "confirmed";
    await order.save();

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "confirmOrder",
        subject: "confirmOrder",
        orderId: order._id,
        status: "confirmed",
      },
    });

    res.status(200).json({ message: "Order confirmed successfully", order });

    try {
      const clientUser = await User.findById(order.normal);
      if (clientUser && clientUser.email) {
        // Handle nested email object
        const clientEmail = clientUser.email.address || clientUser.email;
        const emailResult = await emailService.sendOrderConfirmation({
          to: clientEmail,
          orderDetails: order.toObject ? order.toObject() : order,
          username: clientUser.username || clientEmail,
        });
        if (!emailResult || !emailResult.success) {
          logUserAction({
            user: req.user._id,
            ip: req.ip,
            action: "guide",
            details: {
              action: "confirmOrder",
              subject: "confirmOrder",
              orderId: order._id,
              error: "Confirmation email send failed",
            },
          });
        }
      }
    } catch (err) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "guide",
        details: {
          action: "confirmOrder",
          subject: "confirmOrder",
          orderId: order._id,
          error: err.message,
        },
      });
    }
    // Removed socket emission

    try {
      const clientUser = await User.findById(order.normal).select(
        "fcmTokens username",
      );
      if (
        clientUser &&
        clientUser.fcmTokens &&
        clientUser.fcmTokens.length > 0
      ) {
        await sendToMultipleDevices(
          clientUser.fcmTokens,
          "Order Confirmed!",
          `Your trip "${order.title || "Trip"}" has been confirmed by the guide!`,
          {
            orderId: order._id.toString(),
            type: "order_confirmed",
            guideId: req.user._id.toString(),
            guideName: req.user.username,
            tripTitle: order.title || "",
            tripDate: order.TripDate ? order.TripDate.toISOString() : "",
            status: "confirmed",
          },
        );
      }
    } catch (notificationErr) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "guide",
        details: {
          action: "confirmOrder",
          subject: "notification_error",
          error: notificationErr.message,
        },
      });
    }
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "confirmOrder",
        subject: "confirmOrder",
        orderId: req.params.id,
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
});

/**
 * @desc    رفض الطلب من قبل المرشد
 * @route   PATCH /api/orders/:id/reject
 * @access  خاص (المرشد)
 */
exports.rejectOrder = asyncHandler(async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order || order.status !== "awaiting_guide_confirmation") {
      return res
        .status(404)
        .json({ message: "Order not found or not in progress" });
    }

    if (order.guide?.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "You are not authorized to reject this order" });
    }

    order.status = "rejected_by_guide";
    const oldGuide = order.guide; // Keep record to restore conflicts
    order.guide = null;
    await order.save();

    // Restore any conflicts this guide might have had
    if (oldGuide) {
      await restoreConflicts(oldGuide);
    }

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "rejectOrder",
        subject: "rejectOrder",
        orderId: order._id,
        status: "rejected_by_guide",
      },
    });

    res.status(200).json({
      message: "Order rejected successfully",
      order,
    });

    // Removed socket emission

    try {
      const clientUser = await User.findById(order.normal).select(
        "fcmTokens username",
      );
      if (
        clientUser &&
        clientUser.fcmTokens &&
        clientUser.fcmTokens.length > 0
      ) {
        await sendToMultipleDevices(
          clientUser.fcmTokens,
          "Order Rejected",
          `Unfortunately, the guide has rejected your trip "${order.title || "Trip"}"`,
          {
            orderId: order._id.toString(),
            type: "order_rejected",
            guideId: req.user._id.toString(),
            guideName: req.user.username,
            tripTitle: order.title || "",
            status: "rejected_by_guide",
          },
        );
      }
    } catch (notificationErr) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "guide",
        details: {
          action: "rejectOrder",
          subject: "notification_error",
          error: notificationErr.message,
        },
      });
    }
  } catch (error) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "guide",
      details: {
        action: "rejectOrder",
        subject: "rejectOrder",
        orderId: req.params.id,
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
});
