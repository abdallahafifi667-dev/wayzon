/**
 * Layer 5: Distance Monitor - مراقبة المسافة بين السائح والمرشد
 * يتتبع إذا ابتعدوا كثيراً ويرسل تنبيهات
 */

const tripStateManager = require("../tripStateManager");
const NotificationService = require("../../controllers/Notification/notificationService");
const { getUserModel } = require("../../models/users.models");
const { getIo, userSocketMap } = require("../../socket");
const { logger } = require("../../monitoring/metrics");
const mapVerifier = require("./mapVerifier");

const DISTANCE_THRESHOLDS = {
  NORMAL: 100,
  WARNING: 300,
  ALERT: 500,
  CRITICAL: 1000,
};

const CROWD_DENSITY_MULTIPLIER = {
  high: 2.5,
  medium: 1.5,
  low: 1,
};

async function checkDistance(tripId, tripDetails) {
  const distance = await tripStateManager.getDistance(tripId);

  if (distance === null) {
    return { status: "insufficient_data", message: "Missing location data" };
  }

  const locations = await tripStateManager.getLocations(tripId);
  const touristCoords = locations.tourist?.coordinates;

  let contextMultiplier = 1;
  if (touristCoords) {
    const mapContext = await mapVerifier.verifyLocation(touristCoords);
    if (mapContext.status === "verified") {
      if (mapContext.isTouristArea)
        contextMultiplier = CROWD_DENSITY_MULTIPLIER.high;
      else if (mapContext.isUrbanArea)
        contextMultiplier = CROWD_DENSITY_MULTIPLIER.medium;
    }
  }

  const adjustedThresholds = {
    warning: DISTANCE_THRESHOLDS.WARNING * contextMultiplier,
    alert: DISTANCE_THRESHOLDS.ALERT * contextMultiplier,
    critical: DISTANCE_THRESHOLDS.CRITICAL * contextMultiplier,
  };

  let level = "normal";
  if (distance > adjustedThresholds.critical) level = "critical";
  else if (distance > adjustedThresholds.alert) level = "alert";
  else if (distance > adjustedThresholds.warning) level = "warning";

  const state = (await tripStateManager.getTripState(tripId)) || {};
  const previousLevel = state.distanceLevel || "normal";

  state.distanceLevel = level;
  state.lastDistanceCheck = Date.now();
  state.lastDistance = distance;

  // Phase 19: Add distance to history for rapid separation check
  if (!state.distanceHistory) state.distanceHistory = [];
  state.distanceHistory.push(distance);
  if (state.distanceHistory.length > 10) state.distanceHistory.shift();

  await tripStateManager.setTripState(tripId, state);

  // Phase 19: Check for rapid separation (Context-Aware)
  const rapidCheck = await checkRapidSeparation(
    tripId,
    touristCoords,
    contextMultiplier,
  );

  if (rapidCheck.rapidSeparation && level === "normal") {
    if (rapidCheck.shouldAlert) {
      logger.info("Rapid separation grace period exceeded", {
        tripId,
        rate: rapidCheck.separationRate,
      });
      // Let the orchestrator decide if notifications should be sent
      return {
        status: "rapid_separation",
        ...rapidCheck,
        distance,
        needsVetting: true,
      };
    } else {
      logger.debug("Rapid separation detected, in grace period", {
        tripId,
        elapsed: rapidCheck.elapsedSeconds,
      });
      return { status: "monitoring_separation", ...rapidCheck, distance };
    }
  }

  if (level !== "normal" && level !== previousLevel) {
    // Return alert details but don't notify yet - let orchestrator vet it
    return {
      status: "distance_breach",
      level,
      distance,
      needsVetting: true,
      adjustedThresholds,
    };
  }

  return {
    status: "checked",
    distance: Math.round(distance),
    level,
    adjustedThresholds,
    contextMultiplier,
    previousLevel,
  };
}

async function handleDistanceWarning(
  tripId,
  tripDetails,
  distance,
  level,
  contextMultiplier,
  options = {},
) {
  if (options.skipNotification) {
    logger.debug("Distance notification skipped via caller option", {
      tripId,
      level,
    });
    return { status: "notification_skipped_by_caller" };
  }
  const io = getIo();
  const touristName = tripDetails.touristName || "Tourist";
  const guideName = tripDetails.guideName || "Guide";

  // Fetch if missing (e.g. if called outside orchestrator update)
  if (
    !tripDetails.touristFCM ||
    !tripDetails.guideFCM ||
    (!tripDetails.touristName && !tripDetails.guideName)
  ) {
    const User = getUserModel();
    const [touristDoc, guideDoc] = await Promise.all([
      User.findById(tripDetails.normal).select("fcmTokens username").lean(),
      User.findById(tripDetails.guide).select("fcmTokens username").lean(),
    ]);
    tripDetails.touristName = tripDetails.touristName || touristDoc?.username;
    tripDetails.guideName = tripDetails.guideName || guideDoc?.username;
    tripDetails.touristFCM = tripDetails.touristFCM || touristDoc?.fcmTokens;
    tripDetails.guideFCM = tripDetails.guideFCM || guideDoc?.fcmTokens;
  }

  const distanceInMeters = Math.round(distance);

  const touristMessage =
    level === "critical"
      ? `⚠️ You are ${distanceInMeters}m away from ${guideName === "Guide" ? "your guide" : guideName}. Please stay close for your safety!`
      : `You're ${distanceInMeters}m from ${guideName === "Guide" ? "your guide" : guideName}. Is this intentional?`;

  const guideMessage = `${touristName === "Tourist" ? "Your tourist" : touristName} is ${distanceInMeters}m away. Please check on them.`;

  const touristSocketId = userSocketMap?.get(tripDetails.normal?.toString());
  const guideSocketId = userSocketMap?.get(tripDetails.guide?.toString());

  if (touristSocketId) {
    io.to(touristSocketId).emit("distance_warning", {
      tripId,
      distance: distanceInMeters,
      level,
      message: touristMessage,
    });
  }

  if (guideSocketId) {
    io.to(guideSocketId).emit("distance_warning", {
      tripId,
      distance: distanceInMeters,
      level,
      message: guideMessage,
    });
  }

  if (level === "critical" || level === "alert") {
    const notifications = [];

    if (tripDetails.touristFCM?.length) {
      notifications.push(
        NotificationService.sendToMultipleDevices(
          tripDetails.touristFCM,
          "Distance Alert",
          touristMessage,
          { tripId, type: "distance_warning", level },
        ),
      );
    }

    if (tripDetails.guideFCM?.length) {
      notifications.push(
        NotificationService.sendToMultipleDevices(
          tripDetails.guideFCM,
          "Distance Alert",
          guideMessage,
          { tripId, type: "distance_warning", level },
        ),
      );
    }

    await Promise.allSettled(notifications);
  }

  await tripStateManager.setPendingResponse(
    tripId,
    "distance_check",
    tripDetails.normal,
  );
}

async function handleDistanceResponse(tripId, userId, response) {
  const state = await tripStateManager.getTripState(tripId);

  if (response.intentional) {
    state.separationAcknowledged = true;
    state.separationReason = response.reason;
    await tripStateManager.setTripState(tripId, state);

    return { status: "acknowledged", continueMonitoring: true };
  }

  if (response.needsHelp) {
    return { status: "needs_help", escalate: true };
  }

  state.separationAcknowledged = false;
  await tripStateManager.setTripState(tripId, state);

  return { status: "unknown", continueMonitoring: true };
}

async function checkRapidSeparation(tripId, coordinates, contextMultiplier) {
  const state = await tripStateManager.getTripState(tripId);

  if (!state?.distanceHistory || state.distanceHistory.length < 3) {
    return { rapidSeparation: false };
  }

  const recent = state.distanceHistory.slice(-3);
  const isIncreasing = recent[2] > recent[1] && recent[1] > recent[0];
  const rate = (recent[2] - recent[0]) / 2;

  if (isIncreasing && rate > 50) {
    // Track when this trend started
    if (!state.rapidSeparationStart) {
      state.rapidSeparationStart = Date.now();
      await tripStateManager.setTripState(tripId, state);
    }

    const elapsed = (Date.now() - state.rapidSeparationStart) / 1000;

    // Analyze context to set grace period (1-3 minutes)
    let gracePeriod = 60; // Default 1 minute
    let cause = "unknown";

    if (coordinates) {
      const mapContext = await mapVerifier.verifyLocation(coordinates);
      if (
        mapContext.locationType === "commercial" ||
        mapContext.isTouristArea
      ) {
        gracePeriod = 180; // 3 minutes for shopping/tourist areas
        cause = "potential_shopping_or_browsing";
      }
    }

    return {
      rapidSeparation: true,
      separationRate: rate,
      elapsedSeconds: Math.round(elapsed),
      gracePeriod,
      shouldAlert: elapsed >= gracePeriod,
      potentialCause: cause,
      recommendation:
        elapsed >= gracePeriod ? "alert_both_parties" : "wait_and_see",
    };
  }

  // Reset if trend stops
  if (state.rapidSeparationStart) {
    delete state.rapidSeparationStart;
    await tripStateManager.setTripState(tripId, state);
  }

  return { rapidSeparation: false };
}

module.exports = {
  checkDistance,
  handleDistanceWarning,
  handleDistanceResponse,
  checkRapidSeparation,
  DISTANCE_THRESHOLDS,
};
