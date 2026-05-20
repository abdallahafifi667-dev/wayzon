const { getOrderModel } = require("../models/order.models");
const { getUserModel, getUserWalletModel } = require("../models/users.models");
const tripStateManager = require("./tripStateManager");
const NotificationService = require("../controllers/Notification/notificationService");
const { getIo, userSocketMap } = require("../socket");
const { logger } = require("../monitoring/metrics");
const {
  calculateCancellationFee,
  applyCancellationFee,
} = require("../util/paymentUtils");

const MEETING_POINT_RADIUS = 300;
const TOURIST_WAIT_TIME = 15 * 60 * 1000;
const ONROUTE_WAIT_TIME = 30 * 60 * 1000;

async function checkArrivalAtMeetingPoint(tripId, role, coordinates) {
  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip || !trip.meetingPoint?.coordinates) return { arrived: false };

  const distance = tripStateManager.calculateDistance(
    coordinates,
    trip.meetingPoint.coordinates,
  );
  const isAtMeetingPoint = distance <= MEETING_POINT_RADIUS;

  if (!isAtMeetingPoint && distance > MEETING_POINT_RADIUS) {
    await handleWrongLocation(tripId, role, distance, trip);
    return {
      arrived: false,
      wrongLocation: true,
      distance: Math.round(distance),
    };
  }

  if (isAtMeetingPoint) {
    await handleArrival(tripId, role, trip);
    return { arrived: true, distance: Math.round(distance) };
  }

  return { arrived: false, distance: Math.round(distance) };
}

async function handleWrongLocation(tripId, role, distance, trip) {
  const Order = getOrderModel();
  const io = getIo();

  const fieldName =
    role === "guide" ? "guideAtWrongLocation" : "touristAtWrongLocation";
  await Order.updateOne(
    { _id: tripId },
    { $set: { [`meetingTracking.${fieldName}`]: true } },
  );

  const userId = role === "guide" ? trip.guide : trip.normal;
  // Use pre-fetched tokens if available
  let fcmTokens = role === "guide" ? trip.guideFCM : trip.touristFCM;

  if (!fcmTokens) {
    const User = getUserModel();
    const user = await User.findById(userId).select("fcmTokens").lean();
    fcmTokens = user?.fcmTokens;
  }

  const message = `أنت بعيد عن نقطة الالتقاء بـ ${Math.round(distance)} متر. تأكد من المكان الصحيح.`;

  const socketId = userSocketMap?.get(userId?.toString());
  if (socketId) {
    io.to(socketId).emit("wrong_meeting_location", {
      tripId,
      distance: Math.round(distance),
      message,
    });
  }

  if (fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      fcmTokens,
      "📍 مكان خطأ",
      message,
      { tripId, type: "wrong_location", distance: Math.round(distance) },
    );
  }
}

async function handleArrival(tripId, role, trip) {
  const Order = getOrderModel();
  const io = getIo();

  const arrivalField = role === "guide" ? "guideArrivedAt" : "touristArrivedAt";
  const now = new Date();

  await Order.updateOne(
    { _id: tripId },
    { $set: { [`meetingTracking.${arrivalField}`]: now } },
  );

  const updatedTrip = await Order.findById(tripId).lean();
  const otherUserId = role === "guide" ? trip.normal : trip.guide;
  // Use pre-fetched tokens and names
  let otherFCM = role === "guide" ? trip.touristFCM : trip.guideFCM;

  if (!otherFCM) {
    const User = getUserModel();
    const otherUser = await User.findById(otherUserId)
      .select("fcmTokens")
      .lean();
    otherFCM = otherUser?.fcmTokens;
  }

  const arrivedUserName =
    role === "guide"
      ? trip.guideName || "المرشد"
      : trip.touristName || "السائح";
  const message = `${arrivedUserName} وصل إلى نقطة الالتقاء`;

  if (trip.serviceType !== "solo_system") {
    const socketId = userSocketMap?.get(otherUserId?.toString());
    if (socketId) {
      io.to(socketId).emit("partner_arrived", { tripId, role, message });
    }

    if (otherFCM?.length) {
      await NotificationService.sendToMultipleDevices(
        otherFCM,
        "وصول",
        message,
        { tripId, type: "partner_arrived", arrivedRole: role },
      );
    }
  }

  if (!updatedTrip.meetingTracking?.[otherArrivalField]) {
    await startWaitingTimer(tripId, role, trip);
  } else {
    await tripStateManager.setMeetingStatus(tripId, true);
    logger.info("Both parties arrived at meeting point", { tripId });
  }
}

async function startWaitingTimer(tripId, arrivedRole, trip) {
  const Order = getOrderModel();
  const state = (await tripStateManager.getTripState(tripId)) || {};

  const otherRole = arrivedRole === "guide" ? "tourist" : "guide";
  const otherUserId = arrivedRole === "guide" ? trip.normal : trip.guide;

  const otherLocations = await tripStateManager.getLocations(tripId);
  const otherLocation =
    arrivedRole === "guide" ? otherLocations.tourist : otherLocations.guide;

  let waitTime = TOURIST_WAIT_TIME;
  let isMoving = false;

  if (otherLocation?.coordinates && trip.meetingPoint?.coordinates) {
    const distance = tripStateManager.calculateDistance(
      otherLocation.coordinates,
      trip.meetingPoint.coordinates,
    );

    if (distance > 100 && distance < 2000) {
      waitTime = ONROUTE_WAIT_TIME;
      isMoving = true;
    }
  }

  await Order.updateOne(
    { _id: tripId },
    { $set: { "meetingTracking.waitingTimerStarted": new Date() } },
  );

  logger.info("Waiting timer started", {
    tripId,
    waitingFor: otherRole,
    waitTime: waitTime / 60000,
    isMoving,
  });

  setTimeout(async () => {
    await checkNoShow(tripId, arrivedRole, otherRole, trip);
  }, waitTime);
}

async function checkNoShow(tripId, arrivedRole, missingRole, trip) {
  const Order = getOrderModel();
  const updatedTrip = await Order.findById(tripId).lean();

  if (!updatedTrip) return;

  const otherArrivalField =
    missingRole === "guide" ? "guideArrivedAt" : "touristArrivedAt";

  if (updatedTrip.meetingTracking?.[otherArrivalField]) {
    return;
  }

  if (
    updatedTrip.status === "cancelled" ||
    updatedTrip.status === "in_progress"
  ) {
    return;
  }

  await handleNoShow(tripId, missingRole, trip);
}

async function handleNoShow(tripId, missingRole, trip) {
  const Order = getOrderModel();
  const User = getUserModel();
  const io = getIo();

  const fee = calculateCancellationFee(trip.price);

  const missingUserId = missingRole === "guide" ? trip.guide : trip.normal;
  const arrivedUserId = missingRole === "guide" ? trip.normal : trip.guide;

  await Order.updateOne(
    { _id: tripId },
    {
      $set: {
        status: "cancelled",
        "meetingTracking.noShowParty": missingRole,
        "cancellation.cancelledBy": missingRole,
        "cancellation.cancelledAt": new Date(),
        "cancellation.reason": `No-show: ${missingRole} did not arrive`,
        "cancellation.feeApplied": true,
        cancellationFee: fee,
      },
    },
  );

  await applyCancellationFee(missingUserId, fee, arrivedUserId);

  // Use pre-fetched tokens if available
  let missingFCM = missingRole === "guide" ? trip.guideFCM : trip.touristFCM;
  let arrivedFCM = missingRole === "guide" ? trip.touristFCM : trip.guideFCM;

  if (!missingFCM || !arrivedFCM) {
    const User = getUserModel();
    const [missingUser, arrivedUser] = await Promise.all([
      User.findById(missingUserId).select("fcmTokens").lean(),
      User.findById(arrivedUserId).select("fcmTokens").lean(),
    ]);
    missingFCM = missingFCM || missingUser?.fcmTokens;
    arrivedFCM = arrivedFCM || arrivedUser?.fcmTokens;
  }

  const missingMessage = `تم إلغاء الرحلة لعدم حضورك. تم خصم رسوم ${fee}$.`;
  const arrivedMessage = `تم إلغاء الرحلة لعدم حضور الطرف الآخر. ستحصل على تعويض ${fee}$.`;

  const missingSock = userSocketMap?.get(missingUserId?.toString());
  const arrivedSock = userSocketMap?.get(arrivedUserId?.toString());

  if (missingSock) {
    io.to(missingSock).emit("trip_cancelled_noshow", {
      tripId,
      fee,
      reason: "no_show",
    });
  }
  if (arrivedSock) {
    io.to(arrivedSock).emit("trip_cancelled_noshow", {
      tripId,
      compensation: fee,
      reason: "partner_no_show",
    });
  }

  if (missingFCM?.length) {
    await NotificationService.sendToMultipleDevices(
      missingFCM,
      "❌ إلغاء الرحلة",
      missingMessage,
      { tripId, type: "no_show_cancelled", fee },
    );
  }
  if (arrivedFCM?.length) {
    await NotificationService.sendToMultipleDevices(
      arrivedFCM,
      "❌ إلغاء الرحلة",
      arrivedMessage,
      { tripId, type: "partner_no_show", compensation: fee },
    );
  }

  await tripStateManager.clearTripState(tripId);
  logger.warn("Trip cancelled due to no-show", { tripId, missingRole, fee });
}

async function validateMeetingPointDistance(tripId, coordinates) {
  const Order = getOrderModel();
  const trip = await Order.findById(tripId).select("meetingPoint").lean();

  if (!trip?.meetingPoint?.coordinates) {
    return { valid: false, error: "No meeting point set" };
  }

  const distance = tripStateManager.calculateDistance(
    coordinates,
    trip.meetingPoint.coordinates,
  );

  return {
    valid: distance <= MEETING_POINT_RADIUS,
    distance: Math.round(distance),
    threshold: MEETING_POINT_RADIUS,
    tooFar: distance > MEETING_POINT_RADIUS,
  };
}

module.exports = {
  checkArrivalAtMeetingPoint,
  handleArrival,
  handleNoShow,
  validateMeetingPointDistance,
  MEETING_POINT_RADIUS,
  TOURIST_WAIT_TIME,
  ONROUTE_WAIT_TIME,
};
