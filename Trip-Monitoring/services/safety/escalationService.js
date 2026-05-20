/**
 * Escalation Service - Layer 4: Escalation to Admin
 * Saves to emergencyAlert and sends notifications to admins
 */

const {
  getEmergencyAlertModel,
} = require("../../models/emergencyAlert.models");
const NotificationService = require("../../controllers/Notification/notificationService");
const { getIo, adminSockets } = require("../../socket");
const tripStateManager = require("../tripStateManager");
const { logger } = require("../../monitoring/metrics");

const ESCALATION_LEVELS = {
  WARNING_SENT: 1,
  NO_RESPONSE: 2,
  SECOND_WARNING: 3,
  ADMIN_NOTIFIED: 4,
  EMERGENCY: 5,
};

let sweeperInterval = null;

async function escalateToAdmin(tripId, context) {
  const EmergencyAlert = getEmergencyAlertModel();
  const {
    coordinates,
    role,
    reason,
    tripDetails,
    aiAnalysis,
    mapVerification,
    responseHistory,
  } = context;

  const alert = await EmergencyAlert.create({
    orderId: tripDetails._id,
    alertType: determineAlertType(reason),
    reason,
    priority: determinePriority(context),
    status: "pending",
    missingParty: role,
    reportDetails: {
      reportedBy: "system",
      description: `Automated escalation: ${reason}`,
      reportedAt: new Date(),
    },
    systemResponses: [
      {
        action: "escalation_created",
        timestamp: new Date(),
        details: {
          coordinates,
          aiAnalysis: aiAnalysis?.situation,
          mapContext: mapVerification?.locationType,
          responseHistory,
        },
      },
    ],
  });

  await tripStateManager.setEscalationLevel(
    tripId,
    ESCALATION_LEVELS.ADMIN_NOTIFIED,
  );
  await tripStateManager.updateTripState(tripId, {
    lastEmergencyAlertId: alert._id,
  });

  await notifyAdmins(alert, context);

  logger.warn("Trip escalated to admin", {
    tripId,
    alertId: alert._id,
    reason,
  });

  return { alertId: alert._id, status: "escalated" };
}

function determineAlertType(reason) {
  if (reason.includes("no_response")) return "safety_concern";
  if (reason.includes("dangerous")) return "location_risk";
  if (reason.includes("lost_tracking")) return "lost_tracking";
  if (reason.includes("separated")) return "separation_alert";
  return "other";
}

function determinePriority(context) {
  const { aiAnalysis, responseHistory, stoppedDuration } = context;

  if (aiAnalysis?.riskLevel === "danger") return "critical";
  if (responseHistory?.length >= 2 && !responseHistory.some((r) => r.responded))
    return "high";
  if (stoppedDuration > 30 * 60 * 1000) return "high";
  if (aiAnalysis?.riskLevel === "warning") return "medium";
  return "low";
}

async function notifyAdmins(alert, context) {
  const io = getIo();

  const alertPayload = {
    alertId: alert._id.toString(),
    tripId: context.tripDetails._id.toString(),
    type: alert.alertType,
    priority: alert.priority,
    reason: alert.reason,
    location: context.coordinates,
    touristName: context.tripDetails.touristName,
    guideName: context.tripDetails.guideName,
    tripTitle: context.tripDetails.title,
    timestamp: new Date().toISOString(),
  };

  if (adminSockets && adminSockets.size > 0) {
    adminSockets.forEach((socketId) => {
      io.to(socketId).emit("emergency_alert", alertPayload);
    });
    return;
  }

  try {
    await NotificationService.sendToTopic(
      process.env.ADMIN_TOPIC || "admin_alerts",
      "🚨 Emergency Alert",
      `Trip safety concern: ${alert.reason}`,
      { alertId: alert._id.toString(), type: "emergency_alert" },
    );
  } catch (err) {
    logger.error("Failed to send admin notification", { error: err.message });
  }
}

async function updateAlertStatus(alertId, status, response = null) {
  const EmergencyAlert = getEmergencyAlertModel();

  const update = {
    status,
    $push: {
      systemResponses: {
        action: `status_updated_to_${status}`,
        timestamp: new Date(),
        details: response,
      },
    },
  };

  if (status === "resolved") {
    update.resolvedAt = new Date();
  }

  await EmergencyAlert.updateOne({ _id: alertId }, update);
}

async function recordUserResponse(tripId, userId, response, responseTime) {
  const state = (await tripStateManager.getTripState(tripId)) || {};

  if (!state.responseHistory) state.responseHistory = [];

  state.responseHistory.push({
    userId,
    response,
    respondedAt: Date.now(),
    responseTime,
    wasQuick: responseTime < 30000,
  });

  state.pendingResponse = null;

  await tripStateManager.setTripState(tripId, state);

  return state;
}

async function checkPendingEscalations(tripId) {
  const state = await tripStateManager.getTripState(tripId);

  if (!state?.pendingResponse) return { needsEscalation: false };

  const waitTime = Date.now() - state.pendingResponse.sentAt;

  if (waitTime > state.pendingResponse.maxWaitTime * 1000) {
    return {
      needsEscalation: true,
      reason: "no_response_timeout",
      waitTime,
      currentLevel: state.escalationLevel || 0,
    };
  }

  return { needsEscalation: false, waitTime };
}

/**
 * Start a global background sweeper to find and process abandoned escalations
 */
function startSafetySweeper(intervalMs = 30000) {
  if (sweeperInterval) return;

  sweeperInterval = setInterval(async () => {
    try {
      const { getOrderModel } = require("../../models/order.models");
      const Order = getOrderModel();

      // Find active trips
      const activeTrips = await Order.find({
        status: { $in: ["in_progress", "Gathering_time"] },
      })
        .select("_id tourist guide")
        .lean();

      for (const trip of activeTrips) {
        const state = await tripStateManager.getTripState(trip._id.toString());
        const check = await checkPendingEscalations(trip._id.toString());
        if (check.needsEscalation) {
          logger.warn("Sweeper detected pending escalation timeout", {
            tripId: trip._id,
            reason: check.reason,
            waitTime: check.waitTime,
          });

          // Phase 4: Fallback escalation trigger for critical situations
          await escalateToAdmin(trip._id.toString(), {
            reason: check.reason,
            coordinates:
              state?.lastTouristLocation || state?.lastGuideLocation || null,
            role: "unknown",
            tripDetails: trip,
            responseHistory: state?.responseHistory || [],
          });
        }
      }
    } catch (err) {
      logger.error("Safety sweeper failed", { error: err.message });
    }
  }, intervalMs);

  logger.info("Global Safety Sweeper started", { intervalMs });
}

function stopSafetySweeper() {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
    logger.info("Global Safety Sweeper stopped");
  }
}

module.exports = {
  escalateToAdmin,
  updateAlertStatus,
  recordUserResponse,
  checkPendingEscalations,
  ESCALATION_LEVELS,
  startSafetySweeper,
  stopSafetySweeper,
};
