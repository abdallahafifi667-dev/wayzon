const { getOrderModel } = require("../models/order.models");
const Order = getOrderModel();
const { getUserModel, getUserWalletModel } = require("../models/users.models");
const User = getUserModel();
const { getUserReview } = require("../models/Review.models");
const Review = getUserReview();
const asyncHandler = require("express-async-handler");
const xss = require("xss");
const { validateOrderDataController } = require("../validators/OrderValidator");
const { getIo } = require("../socket");
const { sendToMultipleDevices } = require("./Notification/notificationService");
const {
  calculateCommission,
  canUserBookTrip,
  addCommissionDebt,
  deductCredits,
  PREMIUM_SAFETY_FEE,
} = require("../util/paymentUtils");
const {
  shouldApplyCancellationFee,
  calculateCancellationFee,
  applyCancellationFee,
} = require("../util/paymentUtils");
const { logUserAction } = require("../util/auditLogger");
const countryData = require("../models/countries.json");
const { logger } = require("../monitoring/metrics");
const { withdrawConflicts, restoreConflicts } = require("../util/tripUtils");

/**
 * @desc    إنشاء طلب جديد
 * @route   POST /api/orders
 * @access  خاص (السائح)
 */
exports.createOrder = asyncHandler(async (req, res) => {
  try {
    // req.userWallet populated by middleware or we fetch
    let wallet = req.userWallet;
    if (!wallet) {
      const UserWallet = getUserWalletModel();
      wallet = await UserWallet.findOne({ userId: req.user._id }).lean();
    }

    const safetyConfig = req.body.safetyConfig || { plan: "free" };
    const safetyFee = safetyConfig.plan === "premium" ? PREMIUM_SAFETY_FEE : 0;

    // Check eligibility using wallet (including required credits for premium)
    const canBook = canUserBookTrip(wallet, safetyFee);
    if (!canBook.canBook) {
      return res.status(403).json({
        error: `Cannot book trip: ${canBook.reason}`,
        reason: canBook.reason,
        amount: canBook.amount || canBook.count,
      });
    }

    const destinationCountry = xss(req.body.destinationCountry);
    const destinationStatus = xss(req.body.destinationStatus) || "defined";
    const serviceType = xss(req.body.serviceType);

    if (!destinationCountry || !countryData[destinationCountry]) {
      return res.status(400).json({
        error: "Invalid destination country",
        message: "The destination country must be a valid country name",
      });
    }

    const locations = Array.isArray(req.body.locations)
      ? req.body.locations.map((loc, i) => ({
        name: loc.name || `Point ${i + 1}`,
        type: "Point",
        coordinates: [loc.lng, loc.lat],
      }))
      : [];

    const meetingPoint = req.body.meetingPoint
      ? {
        type: "Point",
        coordinates: [req.body.meetingPoint.lng, req.body.meetingPoint.lat],
      }
      : null;



    const data = {
      serviceType: serviceType,
      destinationStatus: destinationStatus,
      normal: req.user._id,
      title: xss(req.body.title),
      description: xss(req.body.description),
      TripDate: xss(req.body.TripDate),
      duration: xss(req.body.duration),
      locations: locations,
      meetingPoint: meetingPoint,
      safetyConfig: safetyConfig,
      safetyFee: safetyFee,
      status:
        destinationStatus === "undefined"
          ? "bidding"
          : serviceType === "solo_system"
            ? "confirmed"
            : "open",
      price: parseFloat(req.body.price),
      destinationCountry: destinationCountry,
      isSolo: req.body.isSolo,
      companionsCount: req.body.companionsCount
        ? parseInt(req.body.companionsCount)
        : 0,
      safetyMode: safetyConfig.plan === "premium" ? "paid" : "free",
      adSupported: safetyConfig.plan === "free",
    };

    const { error } = validateOrderDataController(data);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const commission =
      serviceType === "with_guide" ? calculateCommission(data.price) : 0;

    const order = new Order(data);
    order.commission = commission;
    order.paymentStatus = "pending";
    order.paymentMethod = "cash";
    order.payoutStatus = "pending";

    await order.save();

    if (safetyFee > 0) {
      await deductCredits(req.user._id, safetyFee);
    }

    // Use utility to safely update wallet debt
    await addCommissionDebt(req.user._id, commission);

    res.status(201).json({
      message: "Order created successfully",
      orderId: order._id,
      commission: commission,
    });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "createOrder",
        subject: "createOrder",
      },
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: "An error occurred while creating the order" });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "createOrder",
        subject: "createOrder",
        error: err.message,
      },
    });
  }
});

/**
 * @desc    اظهار المرشدين القريبين
 * @route   GET /api/orders/nearby-guides
 * @access  خاص (السائح)
 */
exports.getNearbyGuides = asyncHandler(async (req, res) => {
  const shuffle = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  };

  try {
    const location = req.user.location;
    const touristLanguages = req.user.languages || [];

    if (!location || !location.coordinates) {
      return res
        .status(200)
        .json({ message: "User location is missing or invalid", guides: [] });
    }

    const touristLanguageNames = touristLanguages.map((lang) =>
      lang.name.toLowerCase(),
    );

    if (touristLanguageNames.length === 0) {
      return res.status(200).json({
        message: "You must have at least one language set in your profile",
        guides: [],
      });
    }

    let distance = 50000;
    let guides = [];
    const MAX_DISTANCE = 150000;

    while (distance <= MAX_DISTANCE && guides.length === 0) {
      guides = await User.aggregate([
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
              role: "guide",
              _id: { $ne: req.user._id },
            },
          },
        },
        {
          $addFields: {
            guideLanguageNames: {
              $map: {
                input: { $ifNull: ["$languages", []] },
                as: "lang",
                in: { $toLower: "$$lang.name" },
              },
            },
          },
        },
        {
          $match: {
            guideLanguageNames: {
              $in: touristLanguageNames,
            },
          },
        },
        {
          $project: {
            username: 1,
            avatar: 1,
            description: 1,
            distance: 1,
            languages: 1,
          },
        },
      ]);

      if (!guides.length) {
        distance *= 2;
      }
    }

    if (!guides.length) {
      return res.status(404).json({
        message: "No nearby guides found",
        guides: [],
      });
    }

    // If no specific distance sort is forced, or if explicitly random, shuffle them
    const shuffledGuides = shuffle([...guides]);

    res.status(200).json({
      message: `Found ${guides.length} guides within ${(distance / 1000).toFixed(1)} km`,
      guides: shuffledGuides,
    });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getNearbyGuides",
        subject: "getNearbyGuides",
      },
    });
  } catch (err) {
    res.status(500).json({
      error: "An error occurred while fetching nearby guides",
      details: err.message,
    });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getNearbyGuides",
        subject: "getNearbyGuides",
        error: err.message,
      },
    });
  }
});

/**
 * @desc    إنشاء طلب جديد مع اختيار المرشد
 * @route   POST /api/orders/with-guide
 * @access  خاص (السائح)
 */
exports.createOrderWithGuide = asyncHandler(async (req, res) => {
  try {
    let wallet = req.userWallet;
    if (!wallet) {
      const UserWallet = getUserWalletModel();
      wallet = await UserWallet.findOne({ userId: req.user._id }).lean();
    }

    const safetyConfig = req.body.safetyConfig || { plan: "free" };
    const safetyFee = safetyConfig.plan === "premium" ? PREMIUM_SAFETY_FEE : 0;

    const canBook = canUserBookTrip(wallet, safetyFee);
    if (!canBook.canBook) {
      return res.status(403).json({
        error: `Cannot book trip: ${canBook.reason}`,
        reason: canBook.reason,
        amount: canBook.amount || canBook.count,
      });
    }

    const {
      guideId,
      title,
      description,
      TripDate,
      duration,
      location,
      meetingPoint,
      price,
    } = req.body;

    const destinationCountry = xss(req.body.destinationCountry);
    const destinationStatus = xss(req.body.destinationStatus) || "defined";
    const serviceType = xss(req.body.serviceType) || "with_guide";

    if (!guideId || !location || !meetingPoint || !destinationCountry) {
      return res.status(400).json({
        error:
          "Missing required fields: guideId, location, meetingPoint, destinationCountry",
      });
    }

    if (!countryData[destinationCountry]) {
      return res.status(400).json({
        error: "Invalid destination country",
        message: "The destination country must be a valid country name",
      });
    }

    const locations =
      Array.isArray(req.body.locations) && req.body.locations.length > 0
        ? req.body.locations.map((loc, i) => ({
            name: (loc.name && String(loc.name).trim()) || `Point ${i + 1}`,
            type: "Point",
            coordinates: [loc.lng, loc.lat],
          }))
        : [
            {
              name: "Primary",
              type: "Point",
              coordinates: [location.lng, location.lat],
            },
          ];

    const meetingPt = {
      type: "Point",
      coordinates: [meetingPoint.lng, meetingPoint.lat],
    };

    const locationsForJoi = locations.map((l) => ({
      type: l.type,
      coordinates: l.coordinates,
    }));

    const data = {
      serviceType,
      destinationStatus,
      normal: req.user._id,
      title: xss(title),
      description: xss(description),
      TripDate: xss(TripDate),
      duration: xss(duration),
      locations: locationsForJoi,
      meetingPoint: meetingPt,
      safetyConfig: safetyConfig,
      safetyFee: safetyFee,
      status: "awaiting_guide_confirmation",
      price: parseFloat(price),
      destinationCountry: destinationCountry,
      isSolo: req.body.isSolo,
      companionsCount: req.body.companionsCount
        ? parseInt(req.body.companionsCount, 10)
        : 0,
      safetyMode: safetyConfig.plan === "premium" ? "paid" : "free",
      adSupported: safetyConfig.plan === "free",
    };

    const { error } = validateOrderDataController(data);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const guideUser = await User.findById(guideId).select("role fcmTokens");
    if (!guideUser || guideUser.role !== "guide") {
      return res.status(400).json({ error: "Invalid guide ID" });
    }

    const commission = calculateCommission(data.price);

    const order = new Order({
      ...data,
      locations,
      meetingPoint: meetingPt,
      guide: guideId,
      commission,
      paymentStatus: "pending",
      paymentMethod: "cash",
      payoutStatus: "pending",
    });

    await order.save();

    if (safetyFee > 0) {
      await deductCredits(req.user._id, safetyFee);
    }

    await addCommissionDebt(req.user._id, commission);

    try {
      if (guideUser.fcmTokens?.length > 0) {
        sendToMultipleDevices(
          guideUser.fcmTokens,
          "New Order Assigned!",
          `You have a new order: ${title}`,
        );
      }
    } catch (notificationErr) {
      logUserAction({
        user: req.user._id,
        ip: req.ip,
        action: "user",
        details: {
          action: "createOrderWithGuide",
          subject: "createOrderWithGuide",
          error: notificationErr.message,
        },
      });
    }

    res.status(201).json({
      message: "Order created successfully",
      orderId: order._id,
    });
  } catch (err) {
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "createOrderWithGuide",
        subject: "createOrderWithGuide",
        error: err.message,
      },
    });
    res.status(500).json({
      error: "An error occurred while creating the order",
    });
  }
});

/**
 * @desc   جلب الطلب الى السائح
 * @route   GET /api/orders/order/:id
 * @access  خاص (السائح)
 */
exports.getOrders = asyncHandler(async (req, res) => {
  try {
    const { status, page = 1, limit = 10, select, id } = req.query;
    const skip = (page - 1) * limit;

    const filter = { normal: req.user._id };
    if (status) filter.status = status;
    if (id) filter._id = id;

    const [orders, totalOrders] = await Promise.all([
      Order.find(filter)
        .select(
          select ||
          "_id title description TripDate location meetingPoint status price Interested guide serviceType destinationCountry",
        )
        .populate({
          path: "Interested",
          select: "username avatar",
          model: User,
        })
        .populate({
          path: "guide",
          select: "username avatar",
          model: User,
        })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.status(200).json({
      total: totalOrders,
      currentPage: Number(page),
      totalPages: Math.ceil(totalOrders / limit) || 0,
      data: orders || [],
    });
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getOrders",
        subject: "getOrders",
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "An error occurred while fetching orders",
      details: error.message,
    });
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getOrders",
        subject: "getOrders",
        error: error.message,
      },
    });
  }
});

/**
 * @desc    إنشاء طلب سريع (اختيار تلقائي لمقدم الخدمة القريب)
 * @route   POST /api/orders/quick
 * @access  خاص (السائح)
 */
exports.createQuickOrder = asyncHandler(async (req, res) => {
  const user = req.user;
  const { error } = createQuickOrderValidate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const UserWallet = getUserWalletModel();
  const wallet = await UserWallet.findOne({ userId: user._id }).lean();

  const safetyConfig = req.body.safetyConfig || { plan: "free" };
  const safetyFee = safetyConfig.plan === "premium" ? PREMIUM_SAFETY_FEE : 0;

  const canBook = canUserBookTrip(wallet, safetyFee);
  if (!canBook.canBook) {
    return res.status(403).json({
      error: `Cannot book trip: ${canBook.reason}`,
      reason: canBook.reason,
      amount: canBook.amount || canBook.count,
    });
  }

  const {
    _id,
    serviceType,
    title,
    description,
    TripDate,
    duration,
    location,
    meetingPoint,
    price,
  } = req.body;

  const nearbyProviders = await User.aggregate([
    {
      $geoNear: {
        near: { type: "Point", coordinates: [location.lng, location.lat] },
        distanceField: "distance",
        spherical: true,
        maxDistance: 50000,
        query: { serviceType },
      },
    },
    { $project: { _id: 1 } },
  ]);

  if (!nearbyProviders.length) {
    return res.status(404).json({
      error: `No ${serviceType}s found near this location`,
    });
  }

  const selectedProvider =
    nearbyProviders[Math.floor(Math.random() * nearbyProviders.length)];

  const order = await Order.create({
    serviceType,
    normal: _id,
    guide: selectedProvider._id,
    title,
    description,
    TripDate,
    duration,
    location: { type: "Point", coordinates: [location.lng, location.lat] },
    meetingPoint: {
      type: "Point",
      coordinates: [meetingPoint.lng, meetingPoint.lat],
    },
    price,
    status: "awaiting_guide_confirmation",
    isSolo: req.body.isSolo,
    companionsCount: req.body.companionsCount
      ? parseInt(req.body.companionsCount)
      : 0,
    safetyConfig,
    safetyFee,
    safetyMode: safetyConfig.plan === "premium" ? "paid" : "free",
    adSupported: safetyConfig.plan === "free",
  });

  if (safetyFee > 0) {
    await deductCredits(user._id, safetyFee);
  }

  try {
    const provider = await User.findById(selectedProvider._id);
    if (provider?.fcmTokens?.length) {
      for (const token of provider.fcmTokens) {
        await NotificationService.sendToDevice(
          token,
          "New Quick Order",
          `You have a new ${serviceType} order: ${title}`,
          {
            orderId: order._id.toString(),
            type: "new_order",
            serviceType,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
        );
      }
    }
  } catch (error) {
    logUserAction({
      user: user?.id,
      ip: req.ip,
      action: "order_failure",
      error: error.message,
    });
  }

  logUserAction({
    user: user?.id,
    ip: req.ip,
    action: "createQuickOrder",
    orderId: order._id,
  });

  res.status(201).json({
    message: `Quick order created and assigned to a ${serviceType}`,
    orderId: order._id,
    providerId: selectedProvider._id,
  });
});

function createQuickOrderValidate(data) {
  const schema = Joi.object({
    _id: Joi.string().required(),
    serviceType: Joi.string().required(),
    title: Joi.string().min(3).required(),
    description: Joi.string().allow(""),
    TripDate: Joi.date().required(),
    duration: Joi.number().min(1).required(),
    location: Joi.object({
      lat: Joi.number().required(),
      lng: Joi.number().required(),
    }).required(),
    meetingPoint: Joi.object({
      lat: Joi.number().required(),
      lng: Joi.number().required(),
    }).required(),
    price: Joi.number().min(0).required(),
    isSolo: Joi.boolean().optional(),
    companionsCount: Joi.number().min(0).optional(),
    safetyConfig: Joi.object({
      plan: Joi.string().valid("free", "premium").default("free"),
    }).optional(),
  });
  return schema.validate(data);
}

/**
 * @desc    مراجعه المتقدمين
 * @route   get /api/orders/order/:id/review
 * @access  خاص (السائح)
 */
exports.reviewApplicants = asyncHandler(async (req, res) => {
  const user = req.user;
  const id =
    req.params.id ||
    req.body?.orderId ||
    req.body?.id ||
    req.query?.orderId ||
    req.query?.id;
  const sortBy = req.query.sortBy || req.body?.sortBy;

  try {
    if (!id) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const order = await Order.findById(id)
      .populate({
        path: "Interested",
        select: "username avatar description location",
        model: User,
      })
      .lean();

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.status !== "open" && order.status !== "bidding") {
      return res
        .status(400)
        .json({ error: "This order is not open for review" });
    }

    if (order.normal.toString() !== user._id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Unify all applicants: Interested (simple acceptance) + Offers (custom bid)
    const applicants = [];

    // 1. Add people from Interested array (Immediate Acceptance)
    for (const guide of order.Interested) {
      const experience = await Order.countDocuments({
        guide: guide._id,
        status: "completed",
      });
      applicants.push({
        ...guide,
        applicantType: "immediate",
        proposedPrice: order.price, // Uses default order price
        experience,
        isOffer: false,
      });
    }

    // 2. Add people from Offers array
    for (const offer of order.offers || []) {
      if (offer.status !== "pending") continue;

      const guide = await User.findById(offer.guide)
        .select("username avatar description location")
        .lean();
      if (!guide) continue;

      const experience = await Order.countDocuments({
        guide: guide._id,
        status: "completed",
      });
      applicants.push({
        ...guide,
        applicantType: "custom_offer",
        proposedPrice: offer.proposedPrice,
        proposedItinerary: offer.proposedItinerary,
        description: offer.description,
        experience,
        isOffer: true,
        offerId: offer._id.toString(),
      });
    }

    // Apply Sorting
    if (sortBy === "lowest_price") {
      applicants.sort((a, b) => a.proposedPrice - b.proposedPrice);
    } else if (sortBy === "most_experienced") {
      applicants.sort((a, b) => b.experience - a.experience);
    } else if (sortBy === "immediate_acceptance") {
      applicants.sort((a, b) => (a.applicantType === "immediate" ? -1 : 1));
    } else {
      // Shuffling by default "without bias"
      for (let i = applicants.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [applicants[i], applicants[j]] = [applicants[j], applicants[i]];
      }
    }

    res.status(200).json({
      message: `Found ${applicants.length} applicants`,
      applicants,
    });

    logUserAction({
      user: user._id,
      ip: req.ip,
      action: "reviewApplicants",
      details: {
        orderId: id,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: "An error occurred while reviewing applicants",
    });

    logUserAction({
      user: user._id,
      ip: req.ip,
      action: "reviewApplicants_error",
      details: { error: err.message },
    });
  }
});

/**
 * @desc    اختيار المرشد للرحلة
 * @route   POST /api/orders/:id/select-guide
 * @access  خاص (السائح)
 */
exports.selectGuide = asyncHandler(async (req, res) => {
  try {
    const id =
      req.params.id || req.body?.orderId || req.body?.id;
    const { guideId } = req.body;

    if (!id) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "open")
      return res
        .status(400)
        .json({ error: "This order is not open for guide selection" });
    if (order.normal.toString() !== req.user._id.toString())
      return res.status(403).json({
        error: "You are not authorized to select a guide for this order",
      });

    const isGuideInterested = order.Interested.some(
      (g) => g.toString() === guideId,
    );
    if (!isGuideInterested)
      return res
        .status(400)
        .json({ error: "This guide has not accepted your order" });

    order.guide = guideId;
    order.status = "confirmed";
    await order.save();

    // Withdraw conflicts for this guide
    await withdrawConflicts(guideId, order);

    const guide = await User.findById(guideId).select("username fcmTokens");

    if (guide?.fcmTokens?.length > 0) {
      try {
        await sendToMultipleDevices(
          guide.fcmTokens,
          "You have been accepted for the trip!",
          `You have been accepted for the trip: ${order.title || "New Trip"}`,
          {
            orderId: order._id.toString(),
            type: "guide_accepted",
            tripTitle: order.title || "",
            tripDate: order.TripDate ? order.TripDate.toISOString() : "",
            status: "confirmed",
            requiresResponse: false,
          },
        );
      } catch (notificationErr) {
        logger.error("Error sending acceptance notification:", notificationErr);
      }
    }

    // Removed socket notification

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "selectGuide",
        subject: "selectGuide",
        orderId: order._id,
      },
    });

    res
      .status(200)
      .json({ message: "Guide selected successfully", orderId: order._id });
  } catch (err) {
    res.status(500).json({ error: "An error occurred while selecting guide" });
  }
});

/**
 * @desc    اختيار عرض من العروض المقدمة
 * @route   POST /api/orders/:id/select-offer
 * @access  خاص (السائح)
 */
exports.selectOffer = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const { offerId } = req.body;

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "bidding" && order.status !== "open")
      return res.status(400).json({ error: "Order is not in bidding state" });
    if (order.normal.toString() !== req.user._id.toString())
      return res.status(403).json({ error: "Unauthorized" });

    const offer = order.offers.id(offerId);
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    // Update order with offer details
    order.guide = offer.guide;
    order.price = offer.proposedPrice;
    if (offer.proposedItinerary && offer.proposedItinerary.length > 0) {
      order.locations = offer.proposedItinerary;
    }
    order.status = "confirmed";
    order.commission = calculateCommission(offer.proposedPrice);

    // Mark this offer as accepted and others as rejected
    offer.status = "accepted";
    order.offers.forEach((o) => {
      if (o._id.toString() !== offerId.toString()) {
        o.status = "rejected";
      }
    });

    await order.save();

    // Withdraw conflicts for this guide
    await withdrawConflicts(offer.guide, order);

    // Notify guide
    const guide = await User.findById(offer.guide).select("fcmTokens");
    if (guide?.fcmTokens?.length > 0) {
      sendToMultipleDevices(
        guide.fcmTokens,
        "Offer Accepted!",
        `Your offer for "${order.title}" has been accepted.`,
      );
    }

    res.status(200).json({ message: "Offer selected successfully", order });
  } catch (err) {
    res
      .status(500)
      .json({
        error: "An error occurred while selecting offer",
        details: err.message,
      });
  }
});

/**
 * @desc    إلغاء الطلب
 * @route   PATCH /api/orders/:id/cancel
 * @access  خاص (السائح فقط)
 */
exports.cancelOrder = asyncHandler(async (req, res) => {
  try {
    const id =
      req.params.id || req.body.orderId || req.body.id;
    const reason = req.body.reason ? xss(req.body.reason) : "User initiated";

    if (!id) {
      return res.status(400).json({
        error: "Order id is required (body.orderId or body.id)",
      });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const cancellableStatuses = new Set([
      "open",
      "bidding",
      "offer_selected",
      "awaiting_guide_confirmation",
      "confirmed",
      "Gathering_time",
      "in_progress",
    ]);

    if (!cancellableStatuses.has(order.status)) {
      return res
        .status(400)
        .json({ error: "Order cannot be cancelled at this stage" });
    }

    if (order.normal.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ error: "You are not authorized to cancel this order" });
    }

    let cancellationFeeApplied = false;
    let feeAmount = 0;

    if (
      order.TripDate &&
      shouldApplyCancellationFee(new Date(order.TripDate))
    ) {
      feeAmount = calculateCancellationFee(order.price);
      cancellationFeeApplied = true;

      try {
        const tourist = await User.findById(order.normal).select(
          "commissionDebt",
        );
        if (order.guide) {
          const guide = await User.findById(order.guide).select("balance");
          await applyCancellationFee(tourist, feeAmount, guide);
        }
      } catch (feeErr) {
        logger.error("Error applying cancellation fee:", feeErr);
      }
    }

    order.status = "cancelled";
    order.cancellation = {
      cancelledBy: req.user._id,
      cancelledAt: new Date(),
      reason,
      feeApplied: cancellationFeeApplied,
    };
    order.cancellationFee = feeAmount;

    await order.save();

    // Restore any conflicts this guide might have had
    if (order.guide) {
      await restoreConflicts(order.guide);
    }

    const responseData = {
      message: "Order cancelled successfully",
      orderId: order._id,
      status: order.status,
      cancellationFee: feeAmount > 0 ? feeAmount : undefined,
    };

    if (cancellationFeeApplied) {
      responseData.warning = `Cancellation fee of $${feeAmount} has been applied to your account. This will be charged on your next order.`;
    }

    res.status(200).json(responseData);

    if (order.guide) {
      // Removed socket notification
    }

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "cancelOrder",
        subject: "cancelOrder",
        orderId: order._id,
        feeApplied: cancellationFeeApplied,
        feeAmount,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Internal server error",
    });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "cancelOrder",
        subject: "cancelOrder",
        error: error.message,
      },
    });
  }
});

/************************************************************************************    */
