/**
 * Speed Analyzer - Layer 6
 * Speed + Vehicle + Transport sanity checks
 * Units: km/h
 */

const tripStateManager = require("../tripStateManager");
const NotificationService = require("../../controllers/Notification/notificationService");
const { getUserModel } = require("../../models/users.models");
const { getIo, userSocketMap } = require("../../socket");
const { logger } = require("../../monitoring/metrics");
const escalationService = require("./escalationService");
const externalSafetyRulesService = require("../externalSafetyRulesService");

/* ===================== CONSTANTS ===================== */

const SPEED_THRESHOLDS = {
  WALKING_MAX: 7,
  VEHICLE_MIN: 20,
  SUSPICIOUS_SLOW: 0.5,
  SUSPICIOUS_FAST: 180,
};

const VEHICLE_LIMITS = {
  car: { max: 160, highway: 130, city: 60 },
  suv: { max: 160, highway: 130, city: 60 },
  bus: { max: 110, highway: 100, city: 50 },
  minibus: { max: 120, highway: 110, city: 50 },
  motorcycle: { max: 170, highway: 140, city: 60 },
  bicycle: { max: 45, highway: 0, city: 25 },
  pedestrian: { max: 8, highway: 0, city: 6 },
};

const TRANSPORT_MODES = {
  plane: { cruiseMin: 600, cruiseMax: 900, anomalyLow: 250, anomalyHigh: 950 },
  train: { cruiseMin: 120, cruiseMax: 300, anomalyLow: 40, anomalyHigh: 350 },
  boat: { cruiseMin: 15, cruiseMax: 60, anomalyLow: 5, anomalyHigh: 80 },
};

const SPEED_WARNING_TIMEOUT = 180000;

/* ===================== CORE ===================== */

async function analyzeSpeed(tripId, role, newCoordinates, timestamp) {
  const state = (await tripStateManager.getTripState(tripId)) || {};

  const locKey = role === "guide" ? "lastGuideLocation" : "lastTouristLocation";
  const timeKey = role === "guide" ? "lastGuideUpdate" : "lastTouristUpdate";
  const historyKey = `${role}SpeedHistory`;

  if (!state[locKey] || !state[timeKey]) {
    return { status: "insufficient_data" };
  }

  const distanceMeters = tripStateManager.calculateDistance(
    state[locKey],
    newCoordinates,
  );
  const timeHours = (timestamp - state[timeKey]) / 3600000;

  if (timeHours <= 0) return { status: "invalid_time" };

  const speed = distanceMeters / 1000 / timeHours;
  const bearing = calculateBearing(state[locKey], newCoordinates);

  state[historyKey] = state[historyKey] || [];
  state[historyKey].push({ speed, bearing, timestamp, distanceMeters });
  if (state[historyKey].length > 20)
    state[historyKey].splice(0, state[historyKey].length - 20);

  // Save current movement metrics for predictive brain
  state.lastSpeed = speed;
  state.lastBearing = bearing;

  await tripStateManager.setTripState(tripId, state);

  const analysis = categorizeSpeed(speed, state[historyKey]);

  return {
    status: "analyzed",
    speed: round(speed),
    ...analysis,
  };
}

async function analyzeSpeedWithVehicle(
  tripId,
  role,
  coordinates,
  timestamp,
  tripDetails,
) {
  const base = await analyzeSpeed(tripId, role, coordinates, timestamp);
  if (base.status !== "analyzed") return base;

  const { speed, avgSpeed } = base;

  /* -------- Transport Mode Detection & Multi-Mode Logic -------- */
  const transport = detectTransportMode(speed, avgSpeed);

  // If it's a high-speed mode (Plane/Train/Boat), handle differently
  if (
    transport &&
    (transport.mode === "plane" ||
      transport.mode === "boat" ||
      transport.mode === "train")
  ) {
    const cfg = TRANSPORT_MODES[transport.mode];

    // 1. Air/Sea Sanity Check (Planes don't obey city limits)
    if (speed > cfg.anomalyHigh) {
      return {
        ...base,
        transportMode: transport.mode,
        anomaly: `impossible_${transport.mode}_speed`,
        recommendation: "verify_gps_integrity",
      };
    }

    return {
      ...base,
      transportMode: transport.mode,
      transportStatus: transport.status,
      recommendation: `standard_${transport.mode}_monitoring`,
    };
  }

  /* -------- Land-Based (Vehicle) Validation with Country Laws -------- */
  const countryRules = await externalSafetyRulesService.fetchCountrySafetyRules(
    tripDetails.destinationCountry,
    tripDetails.destinationCountry, // Using code as name for fallback, service handles lookup
  );

  const guideVehicle = await getGuideVehicle(tripDetails.guide);
  const vehicleType = guideVehicle?.type || "car";
  const limits = VEHICLE_LIMITS[vehicleType] || VEHICLE_LIMITS.car;

  // Use country rules if available and high confidence, otherwise fallback to vehicle defaults
  const highwayMax =
    countryRules && countryRules.confidence > 0.6
      ? countryRules.maxSpeedHighway
      : limits.highway;

  const cityMax =
    countryRules && countryRules.confidence > 0.6
      ? countryRules.maxSpeedCity
      : limits.city;

  // Safety Buffer (e.g. 10% over limit is warning, 30% is critical)
  const warningThreshold = highwayMax * 1.1;
  const criticalThreshold = limits.max; // Capability limit is always critical

  if (speed > criticalThreshold) {
    return {
      ...base,
      anomaly: "exceeds_vehicle_capability",
      recommendation: "escalate_immediately",
      context: { vehicleType, limit: criticalThreshold },
    };
  }

  if (speed > warningThreshold) {
    await handleSpeedWarning(tripId, tripDetails, speed, guideVehicle);
    return {
      ...base,
      warning: "high_speed",
      recommendation: "monitor_closely",
      context: {
        vehicleType,
        countryLimit: highwayMax,
        measured: round(speed),
      },
    };
  }

  return base;
}

/* ===================== HELPERS ===================== */

function detectTransportMode(speed, avgSpeed) {
  for (const [mode, cfg] of Object.entries(TRANSPORT_MODES)) {
    if (speed < cfg.anomalyLow || speed > cfg.anomalyHigh) continue;

    if (avgSpeed >= cfg.cruiseMin && avgSpeed <= cfg.cruiseMax) {
      return { mode, status: "cruise" };
    }

    return { mode, status: "transition" };
  }
  return null;
}

function categorizeSpeed(currentSpeed, history) {
  const avgSpeed =
    history.length >= 3
      ? history.slice(-5).reduce((s, h) => s + h.speed, 0) /
        Math.min(5, history.length)
      : currentSpeed;

  let category = "unknown";
  let anomaly = null;
  let recommendation = "continue_monitoring";

  if (currentSpeed <= SPEED_THRESHOLDS.WALKING_MAX) category = "walking";
  else if (currentSpeed >= SPEED_THRESHOLDS.VEHICLE_MIN) category = "vehicle";

  if (
    currentSpeed < SPEED_THRESHOLDS.SUSPICIOUS_SLOW &&
    avgSpeed > SPEED_THRESHOLDS.WALKING_MAX
  ) {
    anomaly = "sudden_stop";
    recommendation = "check_context";
  }

  if (currentSpeed > SPEED_THRESHOLDS.SUSPICIOUS_FAST) {
    anomaly = "impossible_speed";
    recommendation = "verify_gps";
  }

  if (Math.abs(currentSpeed - avgSpeed) > 50) {
    anomaly =
      currentSpeed > avgSpeed ? "sudden_acceleration" : "sudden_deceleration";
    recommendation = "investigate";
  }

  return {
    category,
    anomaly,
    avgSpeed: round(avgSpeed),
    recommendation,
  };
}

async function getGuideVehicle(guideId) {
  if (!guideId) return null;
  const User = getUserModel();
  const guide = await User.findById(guideId).select("transportation").lean();
  if (!guide?.transportation?.hasVehicle) return { type: "none" };
  return { type: guide.transportation.vehicleType?.toLowerCase() || "car" };
}

/* ===================== WARN & ESCALATE ===================== */

async function handleSpeedWarning(tripId, tripDetails, speed, vehicle) {
  const state = await tripStateManager.getTripState(tripId);
  if (state?.speedWarningActive) return;

  await sendSpeedWarning(tripId, tripDetails, speed, vehicle);

  state.speedWarningActive = true;
  state.speedWarningAt = Date.now();
  await tripStateManager.setTripState(tripId, state);

  setTimeout(
    () => escalateIfStillFast(tripId, tripDetails),
    SPEED_WARNING_TIMEOUT,
  );
}

async function escalateIfStillFast(tripId, tripDetails) {
  const state = await tripStateManager.getTripState(tripId);
  if (!state?.speedWarningActive) return;

  const history = state.guideSpeedHistory || [];
  const avg = history.slice(-3).reduce((s, h) => s + h.speed, 0) / 3;

  if (avg > SPEED_THRESHOLDS.SUSPICIOUS_FAST) {
    await escalationService.escalateToAdmin(tripId, {
      reason: `Persistent dangerous speed (${round(avg)} km/h)`,
      tripDetails,
      aiAnalysis: { riskLevel: "warning" },
    });
    logger.error("Speed escalation triggered", { tripId, avg });
  }

  state.speedWarningActive = false;
  await tripStateManager.setTripState(tripId, state);
}

async function sendSpeedWarning(tripId, tripDetails, speed, vehicle) {
  const User = getUserModel();
  const io = getIo();

  const tourist = await User.findById(tripDetails.normal)
    .select("fcmTokens")
    .lean();
  const socketId = userSocketMap?.get(tripDetails.normal?.toString());

  const message = `High speed detected (${round(speed)} km/h). Please slow down for safety.`;

  if (socketId) {
    io.to(socketId).emit("speed_warning", {
      tripId,
      speed,
      vehicle: vehicle.type,
    });
  }

  if (tourist?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      tourist.fcmTokens,
      "⚠️ Speed Alert",
      message,
      { tripId, type: "speed_warning" },
    );
  }
}

const round = (n) => Math.round(n * 10) / 10;

function calculateBearing(start, end) {
  const [lon1, lat1] = start.map((c) => (c * Math.PI) / 180);
  const [lon2, lat2] = end.map((c) => (c * Math.PI) / 180);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

/* ===================== EXPORTS ===================== */

module.exports = {
  analyzeSpeed,
  analyzeSpeedWithVehicle,
  VEHICLE_LIMITS,
  SPEED_THRESHOLDS,
};
