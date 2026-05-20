/**
 * Trip Controller - تحديث المواقع وإدارة الرحلات
 * يستقبل بيانات الموقع ويحفظها في DB ويشغل نظام الأمان
 */

const { getOrderModel } = require("../models/order.models");
const safetyOrchestrator = require("../services/safetyOrchestrator");
const tripStateManager = require("../services/tripStateManager");
const { logger, MetricsCollector } = require("../monitoring/metrics");
const { auditLog } = require("../util/auditLogger");
const deviceHealthMonitor = require("../services/safety/deviceHealthMonitor");
const distanceMonitor = require("../services/safety/distanceMonitor");
const routeMonitor = require("../services/safety/routeMonitor");
const meetingPointService = require("../services/meetingPointService");
const tripCompletionService = require("../services/tripCompletionService");
const tripFeedbackService = require("../services/tripFeedbackService");

async function updateLocation(req, res) {
  const { tripId, coordinates, accuracy, timestamp } = req.body;
  const userId = req.user._id.toString();
  const role = req.user.role;

  if (!tripId || !coordinates || coordinates.length !== 2) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid location data" });
  }

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  const isParticipant =
    trip.normal?.toString() === userId || trip.guide?.toString() === userId;

  if (!isParticipant) {
    return res
      .status(403)
      .json({ success: false, message: "Not authorized for this trip" });
  }

  if (!["in_progress", "Gathering_time"].includes(trip.status)) {
    return res
      .status(400)
      .json({ success: false, message: "Trip is not active" });
  }

  const locationData = {
    coordinates,
    accuracy: accuracy || 0,
    timestamp: timestamp || Date.now(),
  };

  const userRole = trip.guide?.toString() === userId ? "guide" : "normal";
  const updateField = userRole === "guide" ? "guideMovement" : "clientMovement";

  await Order.updateOne(
    { _id: tripId },
    {
      $push: {
        [updateField]: {
          $each: [locationData],
          $slice: -500,
        },
      },
      $set: {
        [`last${userRole === "guide" ? "Guide" : "Client"}Location`]: {
          type: "Point",
          coordinates,
        },
      },
    },
  );

  MetricsCollector.recordLocationUpdate(trip.destinationCountry);

  const safetyResult = await safetyOrchestrator.processLocationUpdate(
    tripId,
    userRole,
    coordinates,
    trip,
  );

  return res.status(200).json({
    success: true,
    message: "Location updated",
    safety: {
      status: safetyResult.status,
      questionPending: safetyResult.questionSent || false,
    },
  });
}

async function respondToSafetyCheck(req, res) {
  const { tripId, response } = req.body;
  const userId = req.user._id.toString();

  if (!tripId || !response) {
    return res
      .status(400)
      .json({ success: false, message: "Missing tripId or response" });
  }

  const result = await safetyOrchestrator.processUserResponse(
    tripId,
    userId,
    response,
  );

  await auditLog(userId, req.ip, "safety_response", {
    tripId,
    response: response.id || response,
    result: result.status,
  });

  return res.status(200).json({
    success: true,
    ...result,
  });
}

async function getTripStatus(req, res) {
  const { tripId } = req.params;
  const userId = req.user._id.toString();

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  const isParticipant =
    trip.normal?.toString() === userId || trip.guide?.toString() === userId;

  if (!isParticipant) {
    return res.status(403).json({ success: false, message: "Not authorized" });
  }

  const state = await tripStateManager.getTripState(tripId);
  const locations = await tripStateManager.getLocations(tripId);
  const distance = await tripStateManager.getDistance(tripId);

  return res.status(200).json({
    success: true,
    trip: {
      id: trip._id,
      title: trip.title,
      status: trip.status,
      TripDate: trip.TripDate,
    },
    state: {
      hasMet: state?.hasMet || false,
      escalationLevel: state?.escalationLevel || 0,
      pendingQuestion: state?.pendingResponse ? true : false,
    },
    locations: {
      guide: locations.guide?.coordinates || null,
      tourist: locations.tourist?.coordinates || null,
      distance: distance ? Math.round(distance) : null,
    },
  });
}

async function acknowledgeSeparation(req, res) {
  const { tripId, reason, intentional } = req.body;
  const userId = req.user._id.toString();

  if (!tripId) {
    return res.status(400).json({ success: false, message: "Missing tripId" });
  }

  const result = await distanceMonitor.handleDistanceResponse(tripId, userId, {
    intentional: intentional || false,
    reason: reason || "Not specified",
  });

  return res.status(200).json({ success: true, ...result });
}

async function updateDeviceHealth(req, res) {
  const { tripId, battery, signalStrength, networkType, isCharging } = req.body;
  const userId = req.user._id.toString();

  if (!tripId || battery === undefined) {
    return res
      .status(400)
      .json({ success: false, message: "Missing tripId or battery" });
  }

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  const isParticipant =
    trip.normal?.toString() === userId || trip.guide?.toString() === userId;

  if (!isParticipant) {
    return res.status(403).json({ success: false, message: "Not authorized" });
  }

  const result = await deviceHealthMonitor.processDeviceHealth(
    tripId,
    userId,
    { battery, signalStrength, networkType, isCharging },
    trip,
  );

  return res.status(200).json({ success: true, ...result });
}

async function respondToRouteQuestion(req, res) {
  const { tripId, response } = req.body;
  const userId = req.user._id.toString();

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip || trip.normal?.toString() !== userId) {
    return res.status(403).json({ success: false, message: "Not authorized" });
  }

  const result = await routeMonitor.processRouteResponse(
    tripId,
    userId,
    response,
  );

  return res.status(200).json({ success: true, ...result });
}

async function getTripProgress(req, res) {
  const { tripId } = req.params;

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  const progress = await routeMonitor.getTripProgress(tripId, trip);

  return res.status(200).json({ success: true, ...progress });
}

async function checkMeetingPoint(req, res) {
  const { tripId, coordinates } = req.body;
  const userId = req.user._id.toString();

  if (!tripId || !coordinates || coordinates.length !== 2) {
    return res
      .status(400)
      .json({ success: false, message: "Missing tripId or coordinates" });
  }

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  const isGuide = trip.guide?.toString() === userId;
  const isTourist = trip.normal?.toString() === userId;

  if (!isGuide && !isTourist) {
    return res.status(403).json({ success: false, message: "Not authorized" });
  }

  const role = isGuide ? "guide" : "tourist";
  const result = await meetingPointService.checkArrivalAtMeetingPoint(
    tripId,
    role,
    coordinates,
  );

  return res.status(200).json({ success: true, ...result });
}

async function requestCompletion(req, res) {
  const { tripId } = req.body;
  const userId = req.user._id.toString();

  if (!tripId) {
    return res.status(400).json({ success: false, message: "Missing tripId" });
  }

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  const role = trip.guide?.toString() === userId ? "guide" : "tourist";
  const result = await tripCompletionService.requestTripCompletion(
    tripId,
    userId,
    role,
  );

  await auditLog(userId, req.ip, "trip_completion_request", {
    tripId,
    role,
    result: result.status,
  });

  return res.status(result.success ? 200 : 400).json(result);
}

async function cancelTrip(req, res) {
  const { tripId, reason } = req.body;
  const userId = req.user._id.toString();

  if (!tripId) {
    return res.status(400).json({ success: false, message: "Missing tripId" });
  }

  const Order = getOrderModel();
  const trip = await Order.findById(tripId).lean();

  if (!trip) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  const duringExecution = trip.status === "in_progress";
  const result = await tripCompletionService.handleCancellation(
    tripId,
    userId,
    reason,
    duringExecution,
  );

  await auditLog(userId, req.ip, "trip_cancellation", {
    tripId,
    reason,
    duringExecution,
    feeApplied: result.feeApplied,
  });

  return res.status(result.success ? 200 : 400).json(result);
}

async function getPaymentSummary(req, res) {
  const { tripId } = req.params;

  const summary = await tripCompletionService.getPaymentSummary(tripId);

  if (!summary) {
    return res.status(404).json({ success: false, message: "Trip not found" });
  }

  return res.status(200).json({ success: true, ...summary });
}

/**
 * 🌟 تقديم تقييم للرحلة
 * POST /api/trip/:tripId/feedback
 */
async function submitTripFeedback(req, res) {
  try {
    const { tripId } = req.params;
    const feedbackData = req.body;
    const userId = req.user._id.toString();

    const result = await tripFeedbackService.submitFeedback(
      tripId,
      userId,
      feedbackData,
    );

    return res.status(200).json(result);
  } catch (error) {
    logger.error(`Error submitting feedback: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "FEEDBACK_ERROR",
      message: error.message,
    });
  }
}

module.exports = {
  updateLocation,
  respondToSafetyCheck,
  getTripStatus,
  acknowledgeSeparation,
  updateDeviceHealth,
  respondToRouteQuestion,
  getTripProgress,
  checkMeetingPoint,
  requestCompletion,
  cancelTrip,
  getPaymentSummary,
  submitTripFeedback,
};
