const express = require("express");
const router = express.Router();
const tripScheduler = require("../services/tripScheduler");
const { verifyToken } = require("../middlewares/verifytoken");
const { logUserAction } = require("../util/auditLogger");
const { logger, register } = require("../monitoring/metrics");
const { getOrderModel } = require("../models/order.models");
const { getSafetyEventModel } = require("../models/ml.model");
const asyncHandler = require("express-async-handler");

// New imports for admin monitoring endpoints
const initServices = require("../services/initServices");
const mlAnalyzer = require("../services/safety/mlAnalyzer");
const mapVerifier = require("../services/safety/mapVerifier");
const notificationQueueService = require("../services/notificationQueueService");
const locationReputationService = require("../services/safety/locationReputationService");

/**
 * GET /api/system/metrics
 * Expose Prometheus metrics
 */
router.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/**
 * GET /api/system/scheduler/status
 * Get trip scheduler detailed status
 */
router.get("/scheduler/status", verifyToken, (req, res) => {
  res.json({
    ...tripScheduler.getStatus(),
    correlationId: req.correlationId,
  });
});

/**
 * POST /api/system/scheduler/emergency-process
 * Trigger emergency processing of trips
 */
router.post("/scheduler/emergency-process", verifyToken, (req, res) => {
  logger.warn("Emergency process triggered", {
    userId: req.user._id,
    correlationId: req.correlationId,
  });
  tripScheduler.emergencyProcess();
  res.json({
    message: "Emergency processing triggered",
    correlationId: req.correlationId,
  });
});

/**
 * GET /api/system/eventbus/metrics
 * Get EventBus internal metrics
 */
router.get("/eventbus/metrics", verifyToken, (req, res) => {
  // Retrieve eventBus instance from app settings
  const eventBus = req.app.get("eventBus");

  if (!eventBus) {
    return res.status(503).json({
      error: "EventBus not initialized",
      correlationId: req.correlationId,
    });
  }

  res.json({
    ...eventBus.getMetrics(),
    correlationId: req.correlationId,
  });
});

//admin routes

/**
 * GET /api/trip-monitoring/:tripId/status
 * الحصول على حالة الرحلة الحالية بما في ذلك الموقع ومستوى التنبيه
 * يستخدم للـ dashboard والمراقبة
 */
router.get(
  "/:tripId/status",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { tripId } = req.params;
    const userId = req.user.id;

    const Order = getOrderModel();
    const trip = await Order.findById(tripId).lean();
    if (!trip)
      return res
        .status(404)
        .json({
          success: false,
          error: "TRIP_NOT_FOUND",
          message: "Trip not found",
        });

    const isGuide = trip.guide?.toString() === userId;
    const isTourist = trip.normal?.toString() === userId;
    if (!isGuide && !isTourist) {
      return res
        .status(403)
        .json({
          success: false,
          error: "UNAUTHORIZED",
          message: "Not authorized",
        });
    }

    const tripStateManager = require("../services/tripStateManager");
    const tripState = tripStateManager.getTripState(tripId);

    res.json({
      success: true,
      data: {
        tripId,
        status: trip.status,
        guideLocation: tripState?.lastGuideLocation || null,
        touristLocation: tripState?.lastTouristLocation || null,
        escalationLevel: tripState?.escalationLevel || 0,
        routeDeviationDetected: tripState?.routeDeviationDetected || false,
        timeViolationDetected: tripState?.timeViolationDetected || false,
        lastUpdate: tripState?.lastLocationUpdate || null,
      },
    });
  }),
);

/**
 * 📈 الحصول على كل أحداث الرحلة (SafetyEvents)
 * GET /api/smart-trips/:tripId/events
 */
router.get("/:tripId/events", verifyToken, async (req, res) => {
  try {
    const { tripId } = req.params;
    const SafetyEvent = getSafetyEventModel();

    const events = await SafetyEvent.find({ tripId })
      .sort({ timestamp: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      data: {
        tripId,
        eventsCount: events.length,
        events,
      },
    });
  } catch (error) {
    logger.error(`Error fetching trip events: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "EVENTS_ERROR",
      message: error.message,
    });
  }
});

/**
 * 🔍 البحث عن أحداث آمنية معينة
 * GET /api/smart-trips/events/search?type=deviation&riskScore=50
 */
router.get("/events/search", verifyToken, async (req, res) => {
  try {
    const { type, minRiskScore, maxRiskScore, startDate, endDate } = req.query;

    const query = {};

    if (type) query.type = type;
    if (minRiskScore || maxRiskScore) {
      query["aiPrediction.riskScore"] = {};
      if (minRiskScore)
        query["aiPrediction.riskScore"].$gte = parseInt(minRiskScore);
      if (maxRiskScore)
        query["aiPrediction.riskScore"].$lte = parseInt(maxRiskScore);
    }
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const SafetyEvent = getSafetyEventModel();
    const events = await SafetyEvent.find(query)
      .sort({ timestamp: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      data: {
        query,
        eventsCount: events.length,
        events,
      },
    });
  } catch (error) {
    logger.error(`Error searching events: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "SEARCH_ERROR",
      message: error.message,
    });
  }
});

// =============================================
// ADMIN MONITORING ENDPOINTS - Orphaned Functions Integration
// =============================================

/**
 * GET /api/system/services/status
 * Get overall services status (scheduler, device health, escalation sweeper)
 */
router.get("/services/status", verifyToken, (req, res) => {
  try {
    const status = initServices.getServicesStatus();
    res.json({
      success: true,
      data: status,
      correlationId: req.correlationId,
    });
  } catch (error) {
    logger.error("Error getting services status", { error: error.message });
    res.status(500).json({
      success: false,
      error: "SERVICES_STATUS_ERROR",
      message: error.message,
    });
  }
});

/**
 * GET /api/system/ml/stats
 * Get ML model statistics (weights, accuracy, learned events)
 */
router.get("/ml/stats", verifyToken, async (req, res) => {
  try {
    const stats = await mlAnalyzer.getModelStats();
    res.json({
      success: true,
      data: stats,
      correlationId: req.correlationId,
    });
  } catch (error) {
    logger.error("Error getting ML stats", { error: error.message });
    res.status(500).json({
      success: false,
      error: "ML_STATS_ERROR",
      message: error.message,
    });
  }
});

/**
 * GET /api/system/map/providers
 * Get map provider status (Google, OSM, Baidu, Yandex, HERE)
 */
router.get("/map/providers", verifyToken, (req, res) => {
  try {
    const status = mapVerifier.getProviderStatus();
    res.json({
      success: true,
      data: status,
      correlationId: req.correlationId,
    });
  } catch (error) {
    logger.error("Error getting map provider status", { error: error.message });
    res.status(500).json({
      success: false,
      error: "MAP_PROVIDERS_ERROR",
      message: error.message,
    });
  }
});

/**
 * GET /api/system/notifications/stats
 * Get notification queue statistics
 */
router.get("/notifications/stats", verifyToken, (req, res) => {
  try {
    const stats = notificationQueueService.getStats();
    res.json({
      success: true,
      data: stats,
      correlationId: req.correlationId,
    });
  } catch (error) {
    logger.error("Error getting notification stats", { error: error.message });
    res.status(500).json({
      success: false,
      error: "NOTIFICATION_STATS_ERROR",
      message: error.message,
    });
  }
});

/**
 * POST /api/system/notifications/quiet-hours
 * Set quiet hours for a user (notification throttling)
 * Body: { userId, start: 0-23, end: 0-23, timezone: UTC offset }
 */
router.post("/notifications/quiet-hours", verifyToken, async (req, res) => {
  try {
    const { userId, start, end, timezone = 0 } = req.body;

    if (!userId || start === undefined || end === undefined) {
      return res.status(400).json({
        success: false,
        error: "INVALID_PARAMS",
        message: "userId, start, and end are required",
      });
    }

    await notificationQueueService.setQuietHours(userId, start, end, timezone);

    logger.info("Quiet hours set", {
      userId,
      start,
      end,
      timezone,
      by: req.user._id,
    });

    res.json({
      success: true,
      message: "Quiet hours set successfully",
      data: { userId, start, end, timezone },
    });
  } catch (error) {
    logger.error("Error setting quiet hours", { error: error.message });
    res.status(500).json({
      success: false,
      error: "QUIET_HOURS_ERROR",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/system/notifications/quiet-hours/:userId
 * Clear quiet hours for a user
 */
router.delete(
  "/notifications/quiet-hours/:userId",
  verifyToken,
  async (req, res) => {
    try {
      const { userId } = req.params;
      await notificationQueueService.clearQuietHours(userId);

      logger.info("Quiet hours cleared", { userId, by: req.user._id });

      res.json({
        success: true,
        message: "Quiet hours cleared successfully",
      });
    } catch (error) {
      logger.error("Error clearing quiet hours", { error: error.message });
      res.status(500).json({
        success: false,
        error: "CLEAR_QUIET_HOURS_ERROR",
        message: error.message,
      });
    }
  },
);

/**
 * POST /api/system/reputation/check
 * Manual reputation check for a location (admin/testing)
 * Body: { coordinates: [lng, lat], country: "EG" }
 */
router.post("/reputation/check", verifyToken, async (req, res) => {
  try {
    const { coordinates, country } = req.body;

    if (
      !coordinates ||
      !Array.isArray(coordinates) ||
      coordinates.length !== 2
    ) {
      return res.status(400).json({
        success: false,
        error: "INVALID_COORDINATES",
        message: "coordinates must be [lng, lat] array",
      });
    }

    const reputation = await locationReputationService.checkLocationManually(
      coordinates,
      country,
    );

    logger.info("Manual reputation check performed", {
      coordinates,
      country,
      riskLevel: reputation.riskLevel,
      by: req.user._id,
    });

    res.json({
      success: true,
      data: reputation,
    });
  } catch (error) {
    logger.error("Error in manual reputation check", { error: error.message });
    res.status(500).json({
      success: false,
      error: "REPUTATION_CHECK_ERROR",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/system/notifications/queue
 * Clear the entire notification queue
 */
router.delete("/notifications/queue", verifyToken, (req, res) => {
  try {
    const result = notificationQueueService.clearQueue();
    res.json({
      success: true,
      message: `Queue cleared, ${result.cleared} items removed`,
      correlationId: req.correlationId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/system/safety/curfew/:countryCode
 * Remove curfew rules for a country
 */
router.delete("/safety/curfew/:countryCode", verifyToken, async (req, res) => {
  try {
    const { countryCode } = req.params;
    const timeSafetyAnalyzer = require("../services/safety/timeSafetyAnalyzer");
    await timeSafetyAnalyzer.removeCurfew(countryCode);
    res.json({
      success: true,
      message: `Curfew removed for ${countryCode}`,
      correlationId: req.correlationId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/system/safety/config
 * Get all safety thresholds and configuration constants
 */
router.get("/safety/config", verifyToken, (req, res) => {
  try {
    const mlAnalyzer = require("../services/safety/mlAnalyzer");
    const mapVerifier = require("../services/safety/mapVerifier");
    const speedAnalyzer = require("../services/safety/speedAnalyzer");
    const routeMonitor = require("../services/safety/routeMonitor");
    const locationReputationService = require("../services/safety/locationReputationService");
    const meetingPointService = require("../services/meetingPointService");

    res.json({
      success: true,
      config: {
        reputation: {
          thresholds: locationReputationService.RISK_THRESHOLDS,
        },
        movement: {
          speedThresholds: speedAnalyzer.SPEED_THRESHOLDS,
          vehicleLimits: speedAnalyzer.VEHICLE_LIMITS,
          visitRadius: routeMonitor.VISIT_RADIUS,
          deviationThreshold: routeMonitor.ROUTE_DEVIATION_THRESHOLD,
        },
        location: {
          mlRiskRadius: mlAnalyzer.RISK_RADIUS,
          mapSearchRadius: mapVerifier.SEARCH_RADIUS,
          safePlaceTypes: mapVerifier.SAFE_PLACE_TYPES,
          riskyPlaceTypes: mapVerifier.RISKY_PLACE_TYPES,
        },
        meetingPoints: {
          radius: meetingPointService.MEETING_POINT_RADIUS,
          touristWaitTime: meetingPointService.TOURIST_WAIT_TIME,
          onRouteWaitTime: meetingPointService.ONROUTE_WAIT_TIME,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
