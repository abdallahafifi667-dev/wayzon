/**
 * Route Monitor - Layer 9: مراقبة المسار والانحراف
 */

const tripStateManager = require("../tripStateManager");
const mapVerifier = require("./mapVerifier");
const motionBrain = require("../mlBrain/MotionTrajectoryBrain");
const NotificationService = require("../../controllers/Notification/notificationService");
const { getUserModel } = require("../../models/users.models");
const { getOrderModel } = require("../../models/order.models");
const { getIo, userSocketMap } = require("../../socket");
const spatialRiskEngine = require("./spatialRiskEngine");
const { logger } = require("../../monitoring/metrics");
const timerManager = require("../timerManager");

const VISIT_RADIUS = 50;
const ROUTE_DEVIATION_THRESHOLD = 500;
const RESPONSE_TIMEOUT_FIRST = 60;
const RESPONSE_TIMEOUT_SECOND = 120;

const ROUTE_QUESTIONS = {
  first_deviation: {
    type: "route_deviation",
    question: "You seem to be off the planned route. Is this intentional?",
    options: [
      { id: "yes_exploring", label: "Yes, we're exploring" },
      { id: "yes_shortcut", label: "Taking a different route" },
      { id: "no_lost", label: "I'm not sure where we are" },
    ],
    maxWaitTime: RESPONSE_TIMEOUT_FIRST,
  },
  confirm_deviation: {
    type: "route_confirm",
    question: "Please confirm - do you know where you're going?",
    options: [
      { id: "yes_know", label: "Yes, I know" },
      { id: "no_help", label: "No, I need help" },
    ],
    maxWaitTime: RESPONSE_TIMEOUT_SECOND,
  },
};

async function checkRoute(tripId, coordinates, tripDetails) {
  const state = (await tripStateManager.getTripState(tripId)) || {};

  if (!state.hasMet) return { status: "not_started" };

  const unvisited = tripDetails.locations?.filter((l) => !l.visited) || [];
  if (!unvisited.length) return { status: "all_visited" };

  if (tripDetails.destinationStatus === "undefined") {
    return { status: "exploring" };
  }

  const onRoute = await isOnRouteToAnyLocation(coordinates, unvisited);

  if (onRoute.isOnRoute) {
    state.lastOnRouteCheck = Date.now();
    state.routeDeviationCount = 0;
    await tripStateManager.setTripState(tripId, state);
    return { status: "on_route", nearestLocation: onRoute.nearest };
  }

  const nearbyContext = await mapVerifier.verifyLocation(coordinates);
  const hasLogicalStop = nearbyContext.possibleStopReasons?.length > 0;

  if (hasLogicalStop) {
    const isStopped = await checkIfStopped(tripId, coordinates);
    if (isStopped) {
      return {
        status: "logical_stop",
        reason: nearbyContext.possibleStopReasons[0],
      };
    }
  }

  // 2. Trajectory-Based "Silent Vetting"
  const speed = state.lastSpeed || 0;
  const bearing = state.lastBearing || 0;

  // Use the brain to analyze the 30-minute trajectory
  const trajectory = await motionBrain.analyzeTrajectory(
    tripId,
    coordinates,
    speed,
    bearing,
    tripDetails,
  );

  if (trajectory.shouldWait) {
    // Enhanced Silent Vetting: Also check spatial risk of the predicted destination
    if (trajectory.prediction?.coordinates) {
      const predSpatial = await spatialRiskEngine.analyzeSpatialRisk(
        trajectory.prediction.coordinates,
        tripDetails,
      );
      if (predSpatial.riskLevel === "high") {
        logger.warn(
          "Silent Vetting Overridden: User heading towards high-risk spatial zone.",
          {
            tripId,
            zone: predSpatial.riskLevel,
          },
        );
        return {
          status: "off_route_dangerous",
          reason: "heading_to_high_risk_zone",
          spatial: predSpatial,
        };
      }
    }

    logger.debug(
      "Silent Vetting: Deviation matches a logical trajectory. Suppressing alert.",
      {
        tripId,
        tolerance: trajectory.toleranceScore,
        reasoning: trajectory.reasoning,
      },
    );
    return {
      status: "off_route_tolerated",
      reason: trajectory.reasoning,
      confidence: trajectory.toleranceScore,
      prediction: trajectory.prediction,
    };
  }

  // 3. Fallback: Check if heading to any other planned location (Shortcut/Sequence change)
  const headingToOther = await isOnRouteToAnyLocation(
    coordinates,
    tripDetails.locations || [],
  );
  if (headingToOther.isOnRoute) {
    return {
      status: "re_routing",
      isShortcut: true,
      headingTo: headingToOther.nearest.name,
    };
  }

  // 4. Genuine Off-Route
  state.routeDeviationCount = (state.routeDeviationCount || 0) + 1;
  await tripStateManager.setTripState(tripId, state);

  if (state.routeDeviationCount >= 3 && !state.routeDeviationAsked) {
    // Skip deviation alerts for solo explorations
    if (tripDetails.destinationStatus !== "undefined") {
      await askRouteDeviation(tripId, tripDetails, "first_deviation");
      state.routeDeviationAsked = true;
    }
    await tripStateManager.setTripState(tripId, state);
  }

  return {
    status: "off_route",
    deviationCount: state.routeDeviationCount,
    hasLogicalStop,
    nearbyContext,
  };
}

async function isOnRouteToAnyLocation(currentCoords, destinations) {
  if (!destinations.length) return { isOnRoute: true };

  let nearest = null;
  let minDistance = Infinity;

  for (const dest of destinations) {
    const distance = tripStateManager.calculateDistance(
      currentCoords,
      dest.coordinates,
    );
    if (distance < minDistance) {
      minDistance = distance;
      nearest = { name: dest.name, distance, coordinates: dest.coordinates };
    }
  }

  const isOnRoute = minDistance < ROUTE_DEVIATION_THRESHOLD;
  return { isOnRoute, nearest, minDistance };
}

async function checkIfStopped(tripId, coordinates) {
  const state = await tripStateManager.getTripState(tripId);
  if (!state?.lastTouristLocation) return false;

  const distance = tripStateManager.calculateDistance(
    state.lastTouristLocation,
    coordinates,
  );
  return distance < 30;
}

async function markLocationVisited(tripId, coordinates, tripDetails) {
  const Order = getOrderModel();

  for (let i = 0; i < tripDetails.locations.length; i++) {
    const loc = tripDetails.locations[i];
    if (loc.visited) continue;

    const distance = tripStateManager.calculateDistance(
      coordinates,
      loc.coordinates,
    );

    if (distance <= VISIT_RADIUS) {
      await Order.updateOne(
        { _id: tripId },
        {
          $set: {
            [`locations.${i}.visited`]: true,
            [`locations.${i}.visitedAt`]: new Date(),
          },
        },
      );

      const visitedCount =
        tripDetails.locations.filter((l) => l.visited).length + 1;
      const totalCount = tripDetails.locations.length;

      emitVisitEvent(tripId, tripDetails, {
        locationIndex: i,
        locationName: loc.name,
        visitedCount,
        totalCount,
        percentComplete: Math.round((visitedCount / totalCount) * 100),
      });

      logger.info("Location visited", {
        tripId,
        locationName: loc.name,
        index: i,
      });
      return { visited: true, location: loc, index: i };
    }
  }

  return { visited: false };
}

function emitVisitEvent(tripId, tripDetails, data) {
  const io = getIo();

  [tripDetails.normal, tripDetails.guide].forEach((userId) => {
    const socketId = userSocketMap?.get(userId?.toString());
    if (socketId) {
      io.to(socketId).emit("location_visited", { tripId, ...data });
    }
  });
}

async function askRouteDeviation(tripId, tripDetails, questionType) {
  const User = getUserModel();
  const io = getIo();
  const question = ROUTE_QUESTIONS[questionType];

  const tourist = await User.findById(tripDetails.normal)
    .select("fcmTokens")
    .lean();
  const socketId = userSocketMap?.get(tripDetails.normal?.toString());

  const payload = {
    tripId,
    questionType: question.type,
    question: question.question,
    options: question.options,
    maxWaitTime: question.maxWaitTime,
  };

  if (socketId) {
    io.to(socketId).emit("route_deviation_question", payload);
  }

  if (tourist?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      tourist.fcmTokens,
      "Route Check",
      question.question,
      { tripId, type: "route_deviation", ...payload },
    );
  }

  await tripStateManager.setPendingResponse(
    tripId,
    question.type,
    tripDetails.normal,
  );
  scheduleDeviationTimeout(
    tripId,
    question.maxWaitTime,
    tripDetails,
    questionType,
  );
}

function scheduleDeviationTimeout(
  tripId,
  waitSeconds,
  tripDetails,
  questionType,
) {
  timerManager.schedule(
    tripId,
    async () => {
      const state = await tripStateManager.getTripState(tripId);

      if (state?.pendingResponse?.type === ROUTE_QUESTIONS[questionType].type) {
        if (questionType === "first_deviation") {
          await askRouteDeviation(tripId, tripDetails, "confirm_deviation");
        } else {
          await alertGuideOfDeviation(tripId, tripDetails);
        }
      }
    },
    waitSeconds * 1000,
    `route_deviation_${questionType}`,
  );
}

async function alertGuideOfDeviation(tripId, tripDetails) {
  const User = getUserModel();
  const io = getIo();
  const state = await tripStateManager.getTripState(tripId);

  const guide = await User.findById(tripDetails.guide)
    .select("fcmTokens")
    .lean();
  const socketId = userSocketMap?.get(tripDetails.guide?.toString());

  const message =
    "Tourist is off the planned route and not responding. Please check on them.";

  if (socketId) {
    io.to(socketId).emit("tourist_deviation_alert", {
      tripId,
      message,
      touristLocation: state?.lastTouristLocation,
      lastResponseTime: state?.pendingResponse?.sentAt,
    });
  }

  if (guide?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      guide.fcmTokens,
      "⚠️ Tourist Off Route",
      message,
      { tripId, type: "tourist_deviation", priority: "high" },
    );
  }

  state.routeAlertSentToGuide = true;
  await tripStateManager.setTripState(tripId, state);
  logger.warn("Guide alerted about tourist deviation", { tripId });
}

async function processRouteResponse(tripId, userId, response) {
  const state = await tripStateManager.getTripState(tripId);

  if (!state?.pendingResponse) return { status: "no_pending" };

  await tripStateManager.clearPendingResponse(tripId);

  if (response.id === "no_lost" || response.id === "no_help") {
    const tripDetails = await getOrderModel().findById(tripId).lean();
    await alertGuideOfDeviation(tripId, tripDetails);
    return { status: "help_requested" };
  }

  state.routeDeviationAsked = false;
  state.routeDeviationCount = 0;
  state.acknowledgedDeviation = true;
  await tripStateManager.setTripState(tripId, state);

  return { status: "acknowledged", exploring: response.id.includes("yes") };
}

async function getTripProgress(tripId, tripDetails) {
  const visited = tripDetails.locations?.filter((l) => l.visited).length || 0;
  const total = tripDetails.locations?.length || 0;

  return {
    visitedCount: visited,
    totalCount: total,
    percentComplete: total > 0 ? Math.round((visited / total) * 100) : 0,
    remainingLocations:
      tripDetails.locations?.filter((l) => !l.visited).map((l) => l.name) || [],
  };
}

module.exports = {
  checkRoute,
  markLocationVisited,
  processRouteResponse,
  getTripProgress,
  isOnRouteToAnyLocation,
  VISIT_RADIUS,
  ROUTE_DEVIATION_THRESHOLD,
};
