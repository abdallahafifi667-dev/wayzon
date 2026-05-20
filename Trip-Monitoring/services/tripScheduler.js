/**
 * Trip Scheduler - جدولة وتشغيل الرحلات في وقتها
 * يفحص الرحلات المؤكدة ويشغلها + يرسل إشعارات
 */

const { getOrderModel } = require("../models/order.models");
const { getUserModel } = require("../models/users.models");
const NotificationService = require("../controllers/Notification/notificationService");
const tripStateManager = require("./tripStateManager");
const { logger, MetricsCollector } = require("../monitoring/metrics");
const {
  applyCancellationFee,
  calculateCancellationFee,
} = require("../util/paymentUtils");

const CHECK_INTERVAL = 60 * 1000; // كل دقيقة
const GATHERING_WINDOW = 30 * 60 * 1000; // 30 دقيقة قبل الموعد
const NO_SHOW_TIMEOUT = 30 * 60 * 1000; // 30 دقيقة بعد الموعد
const MAINTENANCE_INTERVAL = 6 * 60 * 60 * 1000; // كل 6 ساعات

let schedulerInterval = null;
let maintenanceInterval = null;
let isRunning = false;

async function checkAndActivateTrips() {
  if (isRunning) return;
  isRunning = true;

  try {
    const Order = getOrderModel();
    const User = getUserModel();
    const now = new Date();

    const tripsToGather = await Order.find({
      status: "confirmed",
      TripDate: {
        $lte: new Date(now.getTime() + GATHERING_WINDOW),
        $gte: now,
      },
    }).lean();

    for (const trip of tripsToGather) {
      await Order.updateOne({ _id: trip._id }, { status: "Gathering_time" });

      const [tourist, guide] = await Promise.all([
        User.findById(trip.normal).select("fcmTokens username").lean(),
        User.findById(trip.guide).select("fcmTokens username").lean(),
      ]);

      const notifications = [];
      if (tourist?.fcmTokens?.length) {
        notifications.push(
          NotificationService.sendToMultipleDevices(
            tourist.fcmTokens,
            "Trip Starting Soon!",
            `Your trip "${trip.title}" starts in 30 minutes. Head to the meeting point!`,
            { tripId: trip._id.toString(), type: "gathering_time" },
          ),
        );
      }
      if (guide?.fcmTokens?.length) {
        notifications.push(
          NotificationService.sendToMultipleDevices(
            guide.fcmTokens,
            "Trip Starting Soon!",
            `Your trip "${trip.title}" starts in 30 minutes. Head to the meeting point!`,
            { tripId: trip._id.toString(), type: "gathering_time" },
          ),
        );
      }
      await Promise.allSettled(notifications);

      await tripStateManager.setTripState(trip._id.toString(), {
        status: "Gathering_time",
        startedAt: null,
        hasMet: false,
        escalationLevel: 0,
      });
    }

    const tripsToStart = await Order.find({
      status: "Gathering_time",
      TripDate: { $lte: now },
    }).lean();

    for (const trip of tripsToStart) {
      const state = await tripStateManager.getTripState(trip._id.toString());

      if (state?.hasMet) {
        await Order.updateOne({ _id: trip._id }, { status: "in_progress" });
        await tripStateManager.setTripState(trip._id.toString(), {
          ...state,
          status: "in_progress",
          startedAt: Date.now(),
        });
        MetricsCollector.recordTripStart(
          trip.destinationCountry,
          trip.guide?.toString(),
        );
        continue;
      }

      const timeSinceScheduled =
        now.getTime() - new Date(trip.TripDate).getTime();
      if (timeSinceScheduled > NO_SHOW_TIMEOUT) {
        await handleNoShow(trip);
      }
    }

    await enforceDurationPolicy();

    MetricsCollector.recordSchedulerRun();
  } catch (err) {
    logger.error("Trip scheduler error", { error: err.message });
    MetricsCollector.recordSchedulerError();
  } finally {
    isRunning = false;
  }
}

async function enforceDurationPolicy() {
  try {
    const Order = getOrderModel();
    const tripCompletionService = require("./tripCompletionService");
    const now = Date.now();

    const activeTrips = await Order.find({ status: "in_progress" }).lean();

    for (const trip of activeTrips) {
      const state = await tripStateManager.getTripState(trip._id.toString());
      const startTime = trip.execution?.startedAt || state?.startedAt || trip.TripDate;
      if (!startTime) continue;

      const elapsedMs = now - new Date(startTime).getTime();
      const elapsedHours = elapsedMs / (1000 * 60 * 60);

      // 12-Hour Auto-Close (Strict Policy)
      if (elapsedHours >= 12) {
        logger.warn(`Trip ${trip._id} exceeded 12h policy. Auto-terminating.`, {
          elapsedHours,
        });
        await tripCompletionService.completeTrip(
          trip._id,
          "POLICY_MAX_DURATION_12H",
        );
        continue;
      }

      // 11-Hour Warning (Send once)
      if (elapsedHours >= 11 && elapsedHours < 11.2) {
        const state = await tripStateManager.getTripState(trip._id.toString());
        if (!state?.sent11hWarning) {
          await sendDurationWarning(trip, 1);
          await tripStateManager.updateTripState(trip._id.toString(), {
            sent11hWarning: true,
          });
        }
      }
    }
  } catch (err) {
    logger.error("Error in enforceDurationPolicy", { error: err.message });
  }
}

async function sendDurationWarning(trip, hoursLeft) {
  const User = getUserModel();
  const user = await User.findById(trip.normal).select("fcmTokens").lean();
  if (user?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      user.fcmTokens,
      "⚠️ Trip Policy Warning",
      `Your trip will automatically close in ${hoursLeft} hour(s) due to the 12-hour maximum policy. Please complete your trip or start a new one to continue monitoring.`,
      { tripId: trip._id.toString(), type: "policy_warning", hoursLeft },
    );
  }
}

async function runMaintenance() {
  logger.info("Starting periodic maintenance and learning loop");

  try {
    const Order = getOrderModel();

    // 1. Get unique countries from active or recent trips
    const recentCountries = await Order.distinct("destinationCountry", {
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });

    const timeSafetyAnalyzer = require("./safety/timeSafetyAnalyzer");

    for (const countryCode of recentCountries) {
      if (!countryCode) continue;

      // Phase 10: Learn curfew patterns from historical safety events
      const learnedCurfew =
        await timeSafetyAnalyzer.learnCurfewFromData(countryCode);
      if (learnedCurfew) {
        await timeSafetyAnalyzer.updateCurfewFromML(countryCode, learnedCurfew);
        logger.info("Updated curfew patterns from ML learning", {
          countryCode,
          ...learnedCurfew,
        });
      }
    }

    // 2. Additional maintenance tasks can be added here (e.g., clearing old logs, refreshing ML weights)
    const mlBrain = require("./mlBrain");
    if (typeof mlBrain.refreshWeights === "function") {
      await mlBrain.refreshWeights();
    }

    // 3. Keep global safety rules fresh (Phase 10/11)
    const externalSafetyRulesService = require("./externalSafetyRulesService");
    if (
      typeof externalSafetyRulesService.refreshGlobalSafetyRules === "function"
    ) {
      await externalSafetyRulesService.refreshGlobalSafetyRules();
    }

    // 4. Update ML models from recent trip outcomes
    const mlAnalyzer = require("./safety/mlAnalyzer");
    if (typeof mlAnalyzer.updateFromOutcome === "function") {
      await mlAnalyzer.updateFromOutcome();
    }

    logger.info("Periodic maintenance completed successfully");
  } catch (err) {
    logger.error("Maintenance loop error", { error: err.message });
  }
}

async function handleNoShow(trip) {
  const Order = getOrderModel();
  const User = getUserModel();
  const state = await tripStateManager.getTripState(trip._id.toString());
  const locations = await tripStateManager.getLocations(trip._id.toString());

  let noShowParty = null;
  if (locations.guide && !locations.tourist) {
    noShowParty = "tourist";
  } else if (locations.tourist && !locations.guide) {
    noShowParty = "guide";
  } else if (!locations.guide && !locations.tourist) {
    noShowParty = "both";
  }

  if (!noShowParty) return;

  await Order.updateOne(
    { _id: trip._id },
    {
      status: "cancelled",
      cancellation: {
        cancelledBy: noShowParty,
        cancelledAt: new Date(),
        reason: `No-show: ${noShowParty} did not arrive`,
        feeApplied: noShowParty !== "guide",
      },
    },
  );

  if (noShowParty === "tourist" || noShowParty === "both") {
    const fee = calculateCancellationFee(trip.price);
    await applyCancellationFee(trip.normal, fee, trip.guide);
  }

  const [tourist, guide] = await Promise.all([
    User.findById(trip.normal).select("fcmTokens").lean(),
    User.findById(trip.guide).select("fcmTokens").lean(),
  ]);

  const message =
    noShowParty === "tourist"
      ? "Trip cancelled: Tourist did not arrive"
      : noShowParty === "guide"
        ? "Trip cancelled: Guide did not arrive"
        : "Trip cancelled: Neither party arrived";

  const notifications = [];
  if (tourist?.fcmTokens?.length) {
    notifications.push(
      NotificationService.sendToMultipleDevices(
        tourist.fcmTokens,
        "Trip Cancelled",
        message,
        { tripId: trip._id.toString(), type: "no_show" },
      ),
    );
  }
  if (guide?.fcmTokens?.length) {
    notifications.push(
      NotificationService.sendToMultipleDevices(
        guide.fcmTokens,
        "Trip Cancelled",
        message,
        { tripId: trip._id.toString(), type: "no_show" },
      ),
    );
  }
  await Promise.allSettled(notifications);
  await tripStateManager.clearTripState(trip._id.toString());
}

function start() {
  if (schedulerInterval) return;
  logger.info("Trip scheduler started");
  schedulerInterval = setInterval(checkAndActivateTrips, CHECK_INTERVAL);

  // Start maintenance loop
  maintenanceInterval = setInterval(runMaintenance, MAINTENANCE_INTERVAL);

  checkAndActivateTrips();
  runMaintenance(); // Run immediately on start
}

function stop() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
  logger.info("Trip scheduler and maintenance stopped");
}

function getStatus() {
  return {
    running: !!schedulerInterval,
    checkInterval: CHECK_INTERVAL,
    gatheringWindow: GATHERING_WINDOW,
    noShowTimeout: NO_SHOW_TIMEOUT,
  };
}

function emergencyProcess() {
  checkAndActivateTrips();
}

module.exports = {
  start,
  stop,
  getStatus,
  emergencyProcess,
  checkAndActivateTrips,
};
