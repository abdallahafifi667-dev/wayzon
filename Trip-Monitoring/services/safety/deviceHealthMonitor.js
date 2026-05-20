/**
 * Device Health Monitor - طبقة 7: مراقبة حالة الجهاز
 * يتوقع انقطاع الاتصال بسبب البطارية أو الشبكة
 */

const tripStateManager = require("../tripStateManager");
const NotificationService = require("../../controllers/Notification/notificationService");
const { getUserModel } = require("../../models/users.models");
const { getIo, userSocketMap } = require("../../socket");
const { logger } = require("../../monitoring/metrics");
const { getOrderModel } = require("../../models/order.models");

const BATTERY_THRESHOLDS = {
  CRITICAL: 5,
  LOW: 15,
  WARNING: 25,
};

let monitoringInterval = null;

const SIGNAL_LEVELS = {
  NONE: 0,
  WEAK: 1,
  FAIR: 2,
  GOOD: 3,
  EXCELLENT: 4,
};

async function processDeviceHealth(tripId, userId, healthData, tripDetails) {
  const { battery, signalStrength, networkType, isCharging } = healthData;

  const state = (await tripStateManager.getTripState(tripId)) || {};
  const role =
    userId.toString() === tripDetails.guide?.toString() ? "guide" : "tourist";

  const healthKey = `${role}DeviceHealth`;
  const previousHealth = state[healthKey] || {};

  state[healthKey] = {
    battery,
    signalStrength,
    networkType,
    isCharging,
    lastUpdate: Date.now(),
  };

  const prediction = predictDisconnection(healthData, previousHealth);
  state[`${role}DisconnectRisk`] = prediction;

  await tripStateManager.setTripState(tripId, state);

  if (prediction.risk === "high" || prediction.risk === "critical") {
    await handleDisconnectionRisk(
      tripId,
      userId,
      role,
      prediction,
      tripDetails,
    );
  }

  return {
    status: "processed",
    prediction,
    shouldAlert: prediction.risk === "high" || prediction.risk === "critical",
  };
}

function predictDisconnection(current, previous) {
  const { battery, signalStrength, networkType, isCharging } = current;

  let riskScore = 0;
  const factors = [];

  if (battery <= BATTERY_THRESHOLDS.CRITICAL) {
    riskScore += 50;
    factors.push(`Critical battery (${battery}%)`);
  } else if (battery <= BATTERY_THRESHOLDS.LOW) {
    riskScore += 30;
    factors.push(`Low battery (${battery}%)`);
  } else if (battery <= BATTERY_THRESHOLDS.WARNING) {
    riskScore += 15;
    factors.push(`Battery warning (${battery}%)`);
  }

  if (isCharging) {
    riskScore = Math.max(0, riskScore - 20);
    factors.push("Device charging");
  }

  const signalLevel = parseSignalLevel(signalStrength);
  if (signalLevel === SIGNAL_LEVELS.NONE) {
    riskScore += 40;
    factors.push("No signal");
  } else if (signalLevel === SIGNAL_LEVELS.WEAK) {
    riskScore += 25;
    factors.push("Weak signal");
  } else if (signalLevel === SIGNAL_LEVELS.FAIR) {
    riskScore += 10;
    factors.push("Fair signal");
  }

  if (networkType === "2G" || networkType === "edge") {
    riskScore += 15;
    factors.push(`Slow network (${networkType})`);
  }

  if (previous.battery && !isCharging) {
    const timePassed =
      (Date.now() - (previous.lastUpdate || Date.now())) / 60000;
    const batteryDrain = previous.battery - battery;

    if (timePassed > 0 && batteryDrain > 0) {
      const drainRate = batteryDrain / timePassed;
      const minutesRemaining = battery / drainRate;

      if (minutesRemaining < 30) {
        riskScore += 20;
        factors.push(`~${Math.round(minutesRemaining)} min battery left`);
      }
    }
  }

  if (previous.signalStrength) {
    const prevLevel = parseSignalLevel(previous.signalStrength);
    const currentLevel = parseSignalLevel(signalStrength);
    if (currentLevel < prevLevel) {
      riskScore += 10;
      factors.push("Signal degrading");
    }
  }

  let risk = "low";
  if (riskScore >= 60) risk = "critical";
  else if (riskScore >= 40) risk = "high";
  else if (riskScore >= 20) risk = "medium";

  return {
    risk,
    riskScore,
    factors,
    estimatedTimeToDisconnect: estimateTimeToDisconnect(current, previous),
    recommendation: getRecommendation(risk, factors),
  };
}

function parseSignalLevel(signal) {
  if (!signal) return SIGNAL_LEVELS.GOOD;
  if (typeof signal === "number") {
    if (signal <= 0) return SIGNAL_LEVELS.NONE;
    if (signal <= 1) return SIGNAL_LEVELS.WEAK;
    if (signal <= 2) return SIGNAL_LEVELS.FAIR;
    if (signal <= 3) return SIGNAL_LEVELS.GOOD;
    return SIGNAL_LEVELS.EXCELLENT;
  }
  const str = signal.toString().toLowerCase();
  if (str === "none" || str === "no signal") return SIGNAL_LEVELS.NONE;
  if (str === "weak" || str === "poor") return SIGNAL_LEVELS.WEAK;
  if (str === "fair" || str === "moderate") return SIGNAL_LEVELS.FAIR;
  if (str === "good") return SIGNAL_LEVELS.GOOD;
  return SIGNAL_LEVELS.EXCELLENT;
}

function estimateTimeToDisconnect(current, previous) {
  if (current.isCharging) return null;

  if (parseSignalLevel(current.signalStrength) === SIGNAL_LEVELS.NONE) {
    return 0;
  }

  if (!previous.battery || !previous.lastUpdate) {
    if (current.battery <= BATTERY_THRESHOLDS.CRITICAL) return 10;
    if (current.battery <= BATTERY_THRESHOLDS.LOW) return 30;
    return null;
  }

  const timePassed = (Date.now() - previous.lastUpdate) / 60000;
  const batteryDrain = previous.battery - current.battery;

  if (timePassed > 0 && batteryDrain > 0) {
    const drainRate = batteryDrain / timePassed;
    return Math.round(current.battery / drainRate);
  }

  return null;
}

function getRecommendation(risk, factors) {
  if (risk === "critical") {
    return "Immediate attention: User may lose connection. Notify guide and admin.";
  }
  if (risk === "high") {
    return "User device running low. Alert guide to stay close.";
  }
  if (risk === "medium") {
    return "Monitor device status closely.";
  }
  return "Device status normal.";
}

async function handleDisconnectionRisk(
  tripId,
  userId,
  role,
  prediction,
  tripDetails,
) {
  const otherUserId = role === "guide" ? tripDetails.normal : tripDetails.guide;

  const io = getIo();
  let otherFCM =
    role === "guide" ? tripDetails.touristFCM : tripDetails.guideFCM;

  if (!otherFCM) {
    const User = getUserModel();
    const otherUser = await User.findById(otherUserId)
      .select("fcmTokens")
      .lean();
    otherFCM = otherUser?.fcmTokens;
  }

  const alertMessage =
    role === "tourist"
      ? `⚠️ Tourist's device: ${prediction.factors.join(", ")}. They may lose connection soon.`
      : `⚠️ Guide's device: ${prediction.factors.join(", ")}. They may lose connection soon.`;

  const otherSocketId = userSocketMap?.get(otherUserId?.toString());
  if (otherSocketId) {
    io.to(otherSocketId).emit("device_health_warning", {
      tripId,
      aboutUser: role,
      prediction,
      message: alertMessage,
    });
  }

  if (otherFCM?.length && prediction.risk === "critical") {
    await NotificationService.sendToMultipleDevices(
      otherFCM,
      "⚠️ Connection Risk",
      alertMessage,
      { tripId, type: "device_health_warning", risk: prediction.risk },
    );
  }

  if (prediction.risk === "critical") {
    logger.warn("Critical device health risk", {
      tripId,
      userId: userId.toString(),
      role,
      prediction,
    });
  }
}

async function checkAllActiveTrips() {
  const Order = getOrderModel();
  const activeTrips = await Order.find({
    status: { $in: ["in_progress", "Gathering_time"] },
  })
    .select("_id normal guide")
    .lean();

  const alerts = [];

  for (const trip of activeTrips) {
    const tripId = trip._id.toString();
    const state = await tripStateManager.getTripState(tripId);
    if (!state) continue;

    for (const role of ["tourist", "guide"]) {
      const healthKey = `${role}DeviceHealth`;
      const currentHealth = state[healthKey]; // Renamed `health` to `currentHealth` for clarity with the snippet

      if (!currentHealth) continue;

      // Phase 25: Predictive Disconnection Logic
      const prediction = predictDisconnection(
        currentHealth,
        state[`${role}PreviousHealth`] || {},
      );
      state[`${role}PreviousHealth`] = currentHealth; // Store current health as previous for next check

      if (
        (prediction.risk === "high" || prediction.risk === "critical") &&
        !state[`warned_prediction_${role}`]
      ) {
        logger.warn("Predictive disconnection warning", {
          tripId,
          role,
          ...prediction,
        });

        const otherUserId = role === "tourist" ? trip.guide : trip.normal;
        const io = getIo();
        const socketId = userSocketMap?.get(otherUserId?.toString());

        if (socketId) {
          io.to(socketId).emit("device_health_prediction", {
            tripId,
            message: `⚠️ Communication warning: ${role === "tourist" ? "Tourist" : "Guide"}'s ${prediction.factors.join(", ")}. Connection may be lost soon.`,
            prediction,
          });
        }

        state[`warned_prediction_${role}`] = true;
      }

      await tripStateManager.setTripState(tripId, state); // Save state after updates

      const timeSinceUpdate = Date.now() - (currentHealth.lastUpdate || 0);
      if (timeSinceUpdate > 5 * 60 * 1000) {
        alerts.push({
          tripId: trip._id,
          role,
          issue: "No device health update for 5+ minutes",
          lastUpdate: currentHealth.lastUpdate,
        });
      }
    }
  }

  return alerts;
}

/**
 * Start background monitoring for all active trips
 */
function startMonitoring(intervalMs = 60000) {
  if (monitoringInterval) return;

  monitoringInterval = setInterval(async () => {
    try {
      const alerts = await checkAllActiveTrips();
      if (alerts.length > 0) {
        logger.info("Device health background check found issues", {
          alertCount: alerts.length,
        });
        // Future: Send summary to admin or process each alert
      }
    } catch (err) {
      logger.error("Background device health check failed", {
        error: err.message,
      });
    }
  }, intervalMs);

  logger.info("Background device health monitoring started", { intervalMs });
}

/**
 * Stop background monitoring
 */
function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    logger.info("Background device health monitoring stopped");
  }
}

module.exports = {
  processDeviceHealth,
  BATTERY_THRESHOLDS,
  startMonitoring,
  stopMonitoring,
};
