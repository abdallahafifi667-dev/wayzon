/**
 * Layer 10: Data Collector - جمع البيانات
 * Refactored for Multi-Collection Architecture (Phase 16)
 *
 * Stores raw data for Python ML Brain to process during training
 */

const { getModels } = require("../../models/ml.model");
const tripStateManager = require("../tripStateManager");
const { logger } = require("../../monitoring/metrics");
const mlAnalyzer = require("./mlAnalyzer");

const COLLECTION_ENABLED = process.env.DATA_COLLECTION_ENABLED !== "false";
const SNAPSHOT_SAMPLE_RATE = parseFloat(
  process.env.DATA_COLLECTION_SAMPLE_RATE || "1.0",
);

/**
 * Record a user response to a specific safety event
 */
async function recordUserResponse(eventId, responseData) {
  if (!eventId) return false;

  try {
    const { SafetyOutcome, SafetyEvent } = getModels();

    // Update the outcome document
    await SafetyOutcome.findOneAndUpdate(
      { eventId },
      {
        $set: {
          "userResponse.responded": true,
          "userResponse.answer": responseData.answer,
          "userResponse.responseTime": responseData.responseTime,
          "userResponse.timestamp": new Date(),
          "finalVerdict.verifiedSafe":
            responseData.answer === "yes" || responseData.answer === "safe",
          closedAt: new Date(),
          closedBy: "user",
        },
      },
      { upsert: true },
    );

    // Mark the core event as having an outcome
    await SafetyEvent.findByIdAndUpdate(eventId, { hasOutcome: true });

    return true;
  } catch (err) {
    logger.error(
      "Failed to record user response in decentralized ML architecture",
      { error: err.message, eventId },
    );
    return false;
  }
}

/**
 * Main entry point for collecting safety data and distributing it across collections
 */
async function collectAnalysisData(
  tripId,
  coordinates,
  tripDetails,
  analysisResults,
) {
  if (!COLLECTION_ENABLED) return null;

  try {
    const {
      SafetyEvent,
      SafetyAnalysisSnapshot,
      SafetyTrainingData,
      SafetyOutcome,
    } = getModels();
    const state = await tripStateManager.getTripState(tripId);

    // 1. Create Core SafetyEvent (Lightweight)
    const coreEvent = await SafetyEvent.create({
      tripId,
      eventType: analysisResults.mlBrain?.decisionSource || "analysis_update",
      category: determineCategory(analysisResults),
      riskScore: analysisResults.mlBrain?.riskScore || 0.5,
      riskLevel: analysisResults.mlBrain?.riskLevel || "unknown",
      location: { type: "Point", coordinates },
      decisionSummary: analysisResults.mlBrain?.reasoning,
      participants: {
        tourist: tripDetails.normal,
        guide: tripDetails.guide,
      },
    });

    const eventId = coreEvent._id;

    // 2. Create Analysis Snapshot (Sampled or High Risk)
    const shouldSaveSnapshot =
      analysisResults.mlBrain?.riskLevel !== "safe" ||
      Math.random() < SNAPSHOT_SAMPLE_RATE;
    if (shouldSaveSnapshot) {
      await SafetyAnalysisSnapshot.create({
        eventId,
        tripId,
        layers: buildLayerMap(analysisResults, state),
        rawContext: {
          speed: analysisResults.speed,
          time: analysisResults.time,
          device: state?.deviceHealth,
        },
        apiUsage: {
          googleMaps: analysisResults.map?.apiCalled,
          geminiAI: analysisResults.ai?.aiCalled,
          responseTime: analysisResults.mlBrain?.processingTime,
        },
        processingTimeMs: analysisResults.mlBrain?.processingTime,
        modelVersion: analysisResults.mlBrain?.modelVersion,
      });
      await SafetyEvent.findByIdAndUpdate(eventId, { hasSnapshot: true });
    }

    // 3. Initialize SafetyOutcome
    await SafetyOutcome.create({
      eventId,
      tripId,
      finalVerdict: {
        verifiedSafe: analysisResults.mlBrain?.riskLevel === "safe",
        wasCorrectPrediction: analysisResults.mlBrain?.confidence > 0.8,
      },
    });

    // 4. Create Training Data (Raw data - Python ML Brain does feature extraction)
    await SafetyTrainingData.create({
      eventId,
      // Store raw data instead of pre-extracted features
      rawData: {
        coordinates,
        timestamp: new Date(),
        speed: analysisResults.speed?.speed || 0,
        bearing: analysisResults.speed?.bearing || 0,
        deviceHealth: state?.deviceHealth || {},
        distanceFromGuide: state?.lastDistance || 0,
        tripId: tripDetails._id?.toString(),
        serviceType: tripDetails.serviceType,
        country: tripDetails.country || tripDetails.destinationCountry,
        touristId: tripDetails.normal?.toString(),
        guideId: tripDetails.guide?.toString(),
        // 🆕 Include user profiles for ML training feature extraction
        userProfiles: analysisResults.mlBrain?.userProfiles || null,
      },
      label: analysisResults.mlBrain?.riskScore > 0.5 ? 1 : 0,

      metadata: {
        userSentiment: analysisResults.mlBrain?.userPersonalization?.sentiment,
        prefersFewerMessages:
          analysisResults.mlBrain?.userPersonalization?.prefersSilent,
        tripType: tripDetails.serviceType,
        analysisResult: analysisResults.mlBrain?.riskLevel,
      },
    });

    return eventId;
  } catch (err) {
    logger.error("Decentralized data collection failed", {
      error: err.message,
      tripId,
    });
    return null;
  }
}

/**
 * Helper to build a clean map of layers
 */
function buildLayerMap(results, state) {
  const layers = new Map();
  if (results.speed) layers.set("speed", results.speed);
  if (results.route) layers.set("route", results.route);
  if (results.time) layers.set("time", results.time);
  if (results.ml) layers.set("ml", results.ml);
  if (results.map) layers.set("map", results.map);
  if (results.ai) layers.set("ai", results.ai);
  if (results.distance) layers.set("distance", results.distance);
  if (results.reputation) layers.set("reputation", results.reputation);
  if (results.reputation?.searchData)
    layers.set("search", results.reputation.searchData);

  return layers;
}

/**
 * Determine event category from analysis
 */
function determineCategory(results) {
  if (results.route) return "location";
  if (results.speed || results.distance) return "behavior";
  if (results.device) return "system";
  return "location";
}

/**
 * Record a final outcome (Verification Loop)
 */
async function recordOutcome(eventId, outcome) {
  if (!eventId) return null;

  try {
    const { SafetyOutcome, SafetyEvent } = getModels();

    await SafetyOutcome.findOneAndUpdate(
      { eventId },
      {
        $set: {
          "finalVerdict.wasActualEmergency": outcome.wasActualEmergency,
          "finalVerdict.requiredIntervention": outcome.requiredIntervention,
          "finalVerdict.verifiedSafe": outcome.verifiedSafe,
          "finalVerdict.wasCorrectPrediction": outcome.wasCorrectPrediction,
          interventionDetails: outcome.finalAction,
          closedAt: new Date(),
          closedBy: "system",
        },
      },
    );

    await SafetyEvent.findByIdAndUpdate(eventId, { hasOutcome: true });

    // Phase 18: Close ML loop for Heuristic Layer in real-time
    try {
      await mlAnalyzer.updateFromOutcome(
        eventId,
        outcome.wasCorrectPrediction,
        outcome,
      );
      logger.debug("Heuristic ML weights updated from outcome", { eventId });
    } catch (err) {
      logger.warn("Failed to update heuristic weights", {
        error: err.message,
        eventId,
      });
    }

    return true;
  } catch (err) {
    logger.error("Failed to record decentralized outcome", {
      error: err.message,
      eventId,
    });
    return false;
  }
}

/**
 * Get stats for ML training (Aggregated across collections)
 */
async function getTrainingStats(options = {}) {
  try {
    const { SafetyTrainingData, SafetyOutcome } = getModels();
    const { days = 30 } = options;

    const cutOffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalCount, verifiedCount] = await Promise.all([
      SafetyTrainingData.countDocuments({ createdAt: { $gte: cutOffDate } }),
      SafetyOutcome.countDocuments({
        createdAt: { $gte: cutOffDate },
        "userResponse.responded": true,
      }),
    ]);

    return {
      totalEvents: totalCount,
      verifiedEvents: verifiedCount,
      readyForTraining: totalCount >= 100,
      daysAnalyzed: days,
    };
  } catch (err) {
    logger.error("Failed to get decentralized training stats", {
      error: err.message,
    });
    return { error: err.message };
  }
}

module.exports = {
  collectAnalysisData,
  recordUserResponse,
  recordOutcome,
  getTrainingStats,
};
