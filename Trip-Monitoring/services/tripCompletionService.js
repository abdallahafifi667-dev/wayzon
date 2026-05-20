const { getOrderModel } = require("../models/order.models");
const { getUserModel, getUserWalletModel } = require("../models/users.models");
const tripStateManager = require("./tripStateManager");
const timerManager = require("./timerManager");
const tripFeedbackService = require("./tripFeedbackService");
const NotificationService = require("../controllers/Notification/notificationService");
const { getIo, userSocketMap } = require("../socket");
const { logger, MetricsCollector } = require("../monitoring/metrics");
const billingClient = require("./billingClient");
const {

  calculateCommission,
  addCommissionDebt,
  calculateCancellationFee,
  applyCancellationFee,
} = require("../util/paymentUtils");

const COMMISSION_RATE = 0.05;
const CANCELLATION_WINDOW_HOURS = 24;

async function requestTripCompletion(tripId, userId, role) {
  const Order = getOrderModel();
  const User = getUserModel();
  const io = getIo();

  const trip = await Order.findById(tripId).lean();
  if (!trip) return { success: false, error: "TRIP_NOT_FOUND" };

  if (trip.status !== "in_progress") {
    return { success: false, error: "TRIP_NOT_IN_PROGRESS" };
  }

  const isGuide = trip.guide?.toString() === userId;
  const isTourist = trip.normal?.toString() === userId;

  if (!isGuide && !isTourist) {
    return { success: false, error: "NOT_AUTHORIZED" };
  }

  const confirmField = isGuide ? "guideConfirmed" : "touristConfirmed";
  const confirmAtField = isGuide ? "guideConfirmedAt" : "touristConfirmedAt";

  await Order.updateOne(
    { _id: tripId },
    {
      $set: {
        [`completion.${confirmField}`]: true,
        [`completion.${confirmAtField}`]: new Date(),
      },
    },
  );

  const updatedTrip = await Order.findById(tripId).lean();

  if (
    updatedTrip.completion?.touristConfirmed &&
    updatedTrip.completion?.guideConfirmed
  ) {
    return await finalizeTripCompletion(tripId, updatedTrip);
  }

  const otherUserId = isGuide ? trip.normal : trip.guide;

  // SOLO TRIP HANDLING (Auto-complete if tourist requests)
  if (!otherUserId && isTourist) {
    return await finalizeTripCompletion(tripId, updatedTrip);
  }

  const otherUser = otherUserId
    ? await User.findById(otherUserId).select("fcmTokens").lean()
    : null;
  const requesterName = isGuide ? "The guide" : "The tourist";

  const message = `${requesterName} has requested to complete the trip. Please confirm.`;

  const socketId = userSocketMap?.get(otherUserId?.toString());
  if (socketId) {
    io.to(socketId).emit("completion_requested", { tripId, requestedBy: role });
  }

  if (otherUser?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      otherUser.fcmTokens,
      "🏁 Trip Completion Request",
      message,
      { tripId, type: "completion_request", requestedBy: role },
    );
  }

  return {
    success: true,
    status: "waiting_for_confirmation",
    confirmedBy: role,
  };
}

/**
 * Detect if a trip should be automatically completed
 * @param {string} tripId - The trip ID
 * @param {Array} coordinates - Current [lng, lat]
 * @param {Object} trip - Trip details from DB
 * @returns {Object} { shouldComplete: boolean, reason: string }
 */
async function checkAutoCompletion(tripId, coordinates, trip) {
  // 1. Check if user is at the final destination
  if (trip.locations && trip.locations.length > 0) {
    const finalDest = trip.locations[trip.locations.length - 1];
    const distanceToFinal = tripStateManager.calculateDistance(coordinates, finalDest.coordinates);

    // If within 100m of final destination
    if (distanceToFinal < 100) {
      return {
        shouldComplete: true,
        reason: "REACHED_DESTINATION",
        message: "You have reached your final destination."
      };
    }
  }

  // 2. Check for 12-hour limit (Strict policy)
  const state = await tripStateManager.getTripState(tripId);
  const startTime = trip.execution?.startedAt || state?.startedAt || trip.TripDate;
  const elapsedHours = (Date.now() - new Date(startTime).getTime()) / (1000 * 60 * 60);

  if (elapsedHours >= 12) {
    return {
      shouldComplete: true,
      reason: "MAX_DURATION_12H",
      message: "Trip automatically completed after reaching maximum 12h duration policy."
    };
  }

  return { shouldComplete: false };
}

/**
 * Wrapper for finalizeTripCompletion used by automated systems
 */
async function completeTrip(tripId, reason = "SYSTEM_AUTO_COMPLETE") {
  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();
  if (!trip) return { success: false, error: "TRIP_NOT_FOUND" };

  logger.info(`Auto-completing trip ${tripId}`, { reason });
  return await finalizeTripCompletion(tripId, trip);
}

async function finalizeTripCompletion(tripId, trip) {
  const Order = getOrderModel();
  const User = getUserModel();
  const UserWallet = getUserWalletModel();
  const io = getIo();

  const touristWallet = await UserWallet.findOne({
    userId: trip.normal,
  }).lean();
  const guideWallet = trip.guide
    ? await UserWallet.findOne({ userId: trip.guide }).lean()
    : null;

  const touristDebt = touristWallet?.commissionDebt || 0;
  const guideDebt = guideWallet?.commissionDebt || 0;
  const guideBalance = guideWallet?.balance || 0;

  // ✅ Get Trip State and calculate Start Time early
  const state = await tripStateManager.getTripState(tripId);
  const startTime = trip.execution?.startedAt || state?.startedAt || trip.TripDate;
  const durationMs = Date.now() - new Date(startTime).getTime();
  const durationHours = Math.max(1, durationMs / (1000 * 60 * 60));
  const durationMinutes = Math.round(durationMs / 60000);

  const basePrice = trip.price;

  // ✅ DYNAMIC PRICING (12h Policy)
  let finalPrice = basePrice;

  // Example: Premium monitoring costs extra after 6h, up to 12h
  if (trip.safetyConfig?.plan === "premium") {
    const plateauHours = 6;
    if (durationHours > plateauHours) {
      const extraHours = Math.ceil(Math.min(12, durationHours) - plateauHours);
      const hourlyRate = 1.5;
      finalPrice += extraHours * hourlyRate;
      logger.info("Extra duration fee applied (12h model)", { tripId, extraHours });
    }
  }

  const finalAmount = finalPrice + touristDebt;
  const commission = calculateCommission(finalPrice);

  await Order.updateOne(
    { _id: tripId },
    {
      $set: {
        status: "completed",
        "completion.completedAt": new Date(),
        "completion.finalAmount": finalAmount,
        "completion.touristDebtIncluded": touristDebt,
        "completion.commissionAmount": commission,
        paymentStatus: "pending",
        price: finalPrice, // Update price to reflect calculated amount
      },
    },
  );

  if (touristDebt > 0) {
    await UserWallet.findOneAndUpdate(
      { userId: trip.normal },
      { $set: { commissionDebt: 0, commissionOperationCount: 0 } },
    );
  }

  // Update Guide Wallet (Only if Guide exists)
  if (trip.guide) {
    await addCommissionDebt(trip.guide, commission);

    let guideNetBalance = guideBalance - guideDebt;

    if (guideNetBalance > 0) {
      await UserWallet.findOneAndUpdate(
        { userId: trip.guide },
        { $set: { balance: guideNetBalance, commissionDebt: 0 } },
      );
    } else if (guideNetBalance < 0) {
      await UserWallet.findOneAndUpdate(
        { userId: trip.guide },
        { $set: { balance: 0, commissionDebt: Math.abs(guideNetBalance) } },
      );
    }
  }

  // Targeted Notification (Solo safe)
  const userIds = [trip.normal];
  if (trip.guide) userIds.push(trip.guide);

  const bothUsers = await User.find({ _id: { $in: userIds } })
    .select("fcmTokens")
    .lean();

  const message = `Trip completed successfully! Total amount: $${finalAmount}`;

  for (const user of bothUsers) {
    const socketId = userSocketMap?.get(user._id?.toString());
    if (socketId) {
      io.to(socketId).emit("trip_completed", {
        tripId,
        finalAmount,
        commission,
        touristDebtIncluded: touristDebt,
      });
    }

    if (user.fcmTokens?.length) {
      await NotificationService.sendToMultipleDevices(
        user.fcmTokens,
        "✅ Trip Completed",
        message,
        { tripId, type: "trip_completed", finalAmount },
      );
    }
  }

  // Clear all pending timers for this trip to prevent memory leaks
  timerManager.clearAllForTrip(tripId);

  // Phase 12: Schedule feedback request (after 30 min delay)
  await tripFeedbackService.scheduleFeedbackRequest(tripId, trip);

  MetricsCollector.recordTripCompletion(
    trip.destinationCountry,
    durationMinutes,
  );

  logger.info("Trip completed", {
    tripId,
    finalAmount,
    commission,
    touristDebt,
    guideDebt,
    durationMinutes,
  });

  // ✅ Clean up state AFTER metrics
  await tripStateManager.clearTripState(tripId);

  // ✅ Deduct credits for Trip Completion (System usage cost)
  await billingClient.deductCredits(trip.normal, "TRIP_COMPLETION");

  // Note: scheduleFeedbackRequest already called on line 153


  return {
    success: true,
    status: "completed",
    finalAmount,
    commission,
    touristDebtIncluded: touristDebt,
    message: "Trip completed successfully",
  };
}

async function handleCancellation(
  tripId,
  userId,
  reason,
  duringExecution = false,
) {
  const Order = getOrderModel();
  const User = getUserModel();
  const io = getIo();

  const trip = await Order.findById(tripId).lean();
  if (!trip) return { success: false, error: "TRIP_NOT_FOUND" };

  const isGuide = trip.guide?.toString() === userId;
  const isTourist = trip.normal?.toString() === userId;

  if (!isGuide && !isTourist) {
    return { success: false, error: "NOT_AUTHORIZED" };
  }

  const cancellingRole = isGuide ? "guide" : "tourist";
  const otherUserId = isGuide ? trip.normal : trip.guide;

  // Detect Solo Cancellation (No guide to notify)
  const otherUser = otherUserId
    ? await User.findById(otherUserId).select("fcmTokens").lean()
    : null;
  const cancellerName = isGuide ? "The guide" : "The tourist";

  // ✅ Fix missing variable definitions
  const feeApplied = duringExecution && trip.status === "in_progress";
  const fee = feeApplied ? calculateCancellationFee(trip.price) : 0;
  const requiresReview = duringExecution;

  let message = `Trip cancelled by ${cancellerName}.`;
  if (feeApplied) message += ` You will receive compensation of ${fee}$.`;
  if (requiresReview)
    message = `Trip cancelled during execution. It is under review.`;

  // Only notify other user if they exist
  if (otherUserId) {
    const socketId = userSocketMap?.get(otherUserId.toString());
    if (socketId) {
      io.to(socketId).emit("trip_cancelled", {
        tripId,
        cancelledBy: cancellingRole,
        reason,
        feeApplied,
        fee,
        requiresReview,
      });
    }
  }

  if (otherUser?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      otherUser.fcmTokens,
      "❌ Trip Cancelled",
      message,
      { tripId, type: "trip_cancelled", cancelledBy: cancellingRole },
    );
  }

  // Clear all pending timers for this trip
  timerManager.clearAllForTrip(tripId);

  await tripStateManager.clearTripState(tripId);
  MetricsCollector.recordTripCancellation(cancellingRole);

  logger.info("Trip cancelled", {
    tripId,
    cancelledBy: cancellingRole,
    reason,
    feeApplied,
    fee,
    requiresReview,
    duringExecution,
  });

  return {
    success: true,
    status: "cancelled",
    cancelledBy: cancellingRole,
    feeApplied,
    fee,
    requiresReview,
  };
}

async function getPaymentSummary(tripId) {
  const Order = getOrderModel();
  const UserWallet = getUserWalletModel();

  const trip = await Order.findById(tripId).lean();
  if (!trip) return null;

  const touristWallet = await UserWallet.findOne({
    userId: trip.normal,
  }).lean();
  const guideWallet = await UserWallet.findOne({ userId: trip.guide }).lean();

  const touristDebt = touristWallet?.commissionDebt || 0;
  const guideDebt = guideWallet?.commissionDebt || 0;
  const guideBalance = guideWallet?.balance || 0;

  const commission = calculateCommission(trip.price);
  const totalForTourist = trip.price + touristDebt;
  const guideReceives = trip.price;
  const guideOwes = commission + guideDebt - guideBalance;

  return {
    tripPrice: trip.price,
    touristDebt,
    totalForTourist,
    commission,
    commissionRate: `${COMMISSION_RATE * 100}%`,
    guideDebt,
    guideBalance,
    guideOwes: guideOwes > 0 ? guideOwes : 0,
    guideCredit: guideOwes < 0 ? Math.abs(guideOwes) : 0,
    guideReceives,
  };
}

module.exports = {
  requestTripCompletion,
  finalizeTripCompletion,
  handleCancellation,
  getPaymentSummary,
  checkAutoCompletion,
  completeTrip,
  COMMISSION_RATE,
  CANCELLATION_WINDOW_HOURS,
};
