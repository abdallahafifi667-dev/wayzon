/**
 * Init Services - تهيئة وتشغيل الخدمات
 * يشغل Trip Scheduler وأي خدمات أخرى
 */

const tripScheduler = require("./tripScheduler");
const mlBrain = require("./mlBrain");
const deviceHealthMonitor = require("./safety/deviceHealthMonitor");
const escalationService = require("./safety/escalationService");
const notificationQueueService = require("./notificationQueueService");
const { logger } = require("../monitoring/metrics");

async function initializeServices() {
  try {
    // Start Brain first to load model weights
    await mlBrain.init();

    tripScheduler.start();
    deviceHealthMonitor.startMonitoring();
    escalationService.startSafetySweeper();
    notificationQueueService.startProcessor();
    logger.info("All services initialized successfully");
    return true;
  } catch (err) {
    logger.error("Failed to initialize services", { error: err.message });
    return false;
  }
}

function shutdownServices() {
  tripScheduler.stop();
  deviceHealthMonitor.stopMonitoring();
  escalationService.stopSafetySweeper();
  notificationQueueService.stopProcessor();
  logger.info("All services shut down");
}

function getServicesStatus() {
  const mlAnalyzer = require("./safety/mlAnalyzer");
  const mapVerifier = require("./safety/mapVerifier");
  const speedAnalyzer = require("./safety/speedAnalyzer");
  const routeMonitor = require("./safety/routeMonitor");
  const locationReputationService = require("./safety/locationReputationService");

  return {
    tripScheduler: tripScheduler.getStatus(),
    notificationQueue: notificationQueueService.getStats(),
    deviceHealthMonitor: { status: "running" },
    escalationService: { status: "running" },
    thresholds: {
      risk: locationReputationService.RISK_THRESHOLDS,
      speed: speedAnalyzer.SPEED_THRESHOLDS,
      visitRadius: routeMonitor.VISIT_RADIUS,
      mlRiskRadius: mlAnalyzer.RISK_RADIUS,
      mapSearchRadius: mapVerifier.SEARCH_RADIUS,
    },
  };
}

module.exports = {
  initializeServices,
  shutdownServices,
  getServicesStatus,
};
