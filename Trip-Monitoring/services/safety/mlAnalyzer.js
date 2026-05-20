/**
 * Layer 1: ML Decision Engine - نموذج ML حقيقي للقرارات الذكية
 * يتعلم من البيانات السابقة ويقرر أي طبقة تُستخدم
 */

const { getSafetyEventModel } = require("../../models/ml.model");
const tripStateManager = require("../tripStateManager");
const { client: redis, connectRedis } = require("../../config/redis");
const { logger } = require("../../monitoring/metrics");

const RISK_RADIUS = 1000;
const DATA_FRESHNESS_THRESHOLD = 30 * 24 * 60 * 60 * 1000;
const WEIGHTS_KEY = "ml:decision:weights";

const DEFAULT_WEIGHTS = {
  mlConfidence: 0.3,
  mapReliability: 0.2,
  aiAccuracy: 0.25,
  historicalPatterns: 0.25,
  timeOfDay: 0.1,
  userResponseRate: 0.15,
};

let cachedWeights = null;
let lastWeightUpdate = 0;

async function loadWeights() {
  if (cachedWeights && Date.now() - lastWeightUpdate < 300000) {
    return cachedWeights;
  }

  try {
    if (!redis.isOpen) await connectRedis();
    const stored = await redis.get(WEIGHTS_KEY);
    if (stored) {
      cachedWeights = JSON.parse(stored);
      lastWeightUpdate = Date.now();
      return cachedWeights;
    }
  } catch (err) {
    logger.debug("Failed to load weights from Redis", { error: err.message });
  }

  cachedWeights = { ...DEFAULT_WEIGHTS };
  return cachedWeights;
}

async function saveWeights(weights) {
  try {
    if (!redis.isOpen) await connectRedis();
    await redis.set(WEIGHTS_KEY, JSON.stringify(weights));
    cachedWeights = weights;
    lastWeightUpdate = Date.now();
  } catch (err) {
    logger.debug("Failed to save weights to Redis", { error: err.message });
  }
}

async function analyzeLocation(tripId, coordinates, role) {
  const SafetyEvent = getSafetyEventModel();
  const [lng, lat] = coordinates;
  const weights = await loadWeights();

  const recentEvents = await SafetyEvent.find({
    "location.coordinates": {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: RISK_RADIUS,
      },
    },
    createdAt: { $gte: new Date(Date.now() - DATA_FRESHNESS_THRESHOLD) },
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  if (!recentEvents.length) {
    return {
      status: "no_data",
      riskLevel: null,
      recommendation: "use_map_verification",
      confidence: 0,
      suggestedLayers: [2, 3],
    };
  }

  const analysis = computeRiskAnalysis(recentEvents, coordinates, weights);
  const layerDecision = predictLayerDecision(analysis, weights);

  return {
    status: analysis.isDataFresh ? "analyzed" : "stale_data",
    riskLevel: analysis.riskLevel,
    riskScore: analysis.riskScore,
    confidence: analysis.confidence,
    dataFreshness: analysis.isDataFresh,
    eventsAnalyzed: recentEvents.length,
    patterns: analysis.patterns,
    recommendation: layerDecision.recommendation,
    suggestedLayers: layerDecision.suggestedLayers,
    skipToLayer: layerDecision.skipToLayer,
    reasoning: layerDecision.reasoning,
  };
}

function computeRiskAnalysis(events, coordinates, weights) {
  const now = Date.now();
  const currentHour = new Date().getHours();

  let weightedRiskSum = 0;
  let totalWeight = 0;

  events.forEach((event, idx) => {
    const age = now - new Date(event.createdAt).getTime();
    const freshnessWeight = Math.max(0, 1 - age / DATA_FRESHNESS_THRESHOLD);
    const recencyWeight = Math.max(0.1, 1 - idx / events.length);

    const eventHour = new Date(event.createdAt).getHours();
    const timeSimilarity = 1 - Math.abs(eventHour - currentHour) / 12;

    const eventWeight =
      freshnessWeight *
      recencyWeight *
      (1 + timeSimilarity * weights.timeOfDay);
    const eventRisk = (event.riskScore || 0.5) * 100;

    weightedRiskSum += eventRisk * eventWeight;
    totalWeight += eventWeight;
  });

  const riskScore = totalWeight > 0 ? weightedRiskSum / totalWeight : 50;

  const outcomes = events.filter((e) => e.outcome);
  const correctPredictions = outcomes.filter((e) => {
    const predicted = (e.riskScore || 0.5) > 0.5;
    const actual =
      e.outcome?.wasActualEmergency || e.outcome?.requiredIntervention;
    return predicted === actual;
  }).length;

  const accuracy =
    outcomes.length > 5 ? correctPredictions / outcomes.length : 0.5;
  const confidence = Math.min(
    100,
    Math.round(accuracy * 100 * (1 + Math.log10(events.length + 1) / 2)),
  );

  const mostRecent = events[0];
  const isDataFresh =
    now - new Date(mostRecent.createdAt).getTime() <
    DATA_FRESHNESS_THRESHOLD / 2;

  const patterns = extractAdvancedPatterns(events);

  let riskLevel = "safe";
  if (riskScore > 70) riskLevel = "dangerous";
  else if (riskScore > 50) riskLevel = "warning";
  else if (riskScore > 30) riskLevel = "caution";

  return { riskScore, riskLevel, confidence, isDataFresh, patterns, accuracy };
}

function extractAdvancedPatterns(events) {
  const patterns = {
    commonEventTypes: {},
    hourlyRisk: Array(24).fill(0),
    avgResolution: { responded: 0, ignored: 0, escalated: 0 },
    recentTrend: "stable",
  };

  events.forEach((event) => {
    const type = event.eventType || "unknown";
    patterns.commonEventTypes[type] =
      (patterns.commonEventTypes[type] || 0) + 1;

    const hour = new Date(event.createdAt).getHours();
    patterns.hourlyRisk[hour] += (event.riskScore || 0.5) * 100;

    if (event.outcome?.userResponded) patterns.avgResolution.responded++;
    if (event.outcome?.requiredIntervention) patterns.avgResolution.escalated++;
    if (!event.outcome?.userResponded) patterns.avgResolution.ignored++;
  });

  const recent5 = events.slice(0, 5).map((e) => (e.riskScore || 0.5) * 100);
  const older5 = events.slice(5, 10).map((e) => (e.riskScore || 0.5) * 100);

  if (recent5.length && older5.length) {
    const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
    const olderAvg = older5.reduce((a, b) => a + b, 0) / older5.length;

    if (recentAvg > olderAvg + 10) patterns.recentTrend = "increasing";
    else if (recentAvg < olderAvg - 10) patterns.recentTrend = "decreasing";
  }

  return patterns;
}

function predictLayerDecision(analysis, weights) {
  const { riskScore, confidence, isDataFresh, patterns } = analysis;

  if (confidence > 80 && isDataFresh) {
    if (riskScore < 30) {
      return {
        recommendation: "continue_monitoring",
        suggestedLayers: [],
        skipToLayer: null,
        reasoning: "High confidence, low risk - ML sufficient",
      };
    }
    if (riskScore > 70) {
      return {
        recommendation: "send_warning",
        suggestedLayers: [3, 4],
        skipToLayer: 3,
        reasoning:
          "High confidence, high risk - skip to AI for immediate analysis",
      };
    }
  }

  if (!isDataFresh || confidence < 50) {
    return {
      recommendation: "use_map_verification",
      suggestedLayers: [2, 3],
      skipToLayer: 2,
      reasoning: "Stale or low confidence data - verify with Maps",
    };
  }

  if (patterns.recentTrend === "increasing") {
    return {
      recommendation: "escalate_check",
      suggestedLayers: [2, 3],
      skipToLayer: 2,
      reasoning: "Risk trend increasing - additional verification needed",
    };
  }

  return {
    recommendation: "continue_with_monitoring",
    suggestedLayers: [2],
    skipToLayer: null,
    reasoning: "Moderate confidence - continue normal flow",
  };
}

async function updateFromOutcome(eventId, wasCorrect, actualOutcome) {
  const weights = await loadWeights();

  const learningRate = 0.05;

  if (wasCorrect) {
    weights.mlConfidence = Math.min(0.5, weights.mlConfidence + learningRate);
  } else {
    weights.mlConfidence = Math.max(0.1, weights.mlConfidence - learningRate);
    weights.aiAccuracy = Math.min(0.4, weights.aiAccuracy + learningRate * 0.5);
  }

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const key in weights) {
    weights[key] = weights[key] / total;
  }

  await saveWeights(weights);

  try {
    const SafetyEvent = getSafetyEventModel();
    await SafetyEvent.updateOne(
      { _id: eventId },
      {
        $set: {
          "outcome.wasCorrectPrediction": wasCorrect,
          "outcome.learnedAt": new Date(),
        },
      },
    );
  } catch (err) {
    logger.debug("Failed to update SafetyEvent outcome", {
      error: err.message,
      eventId,
    });
  }
}

async function recordAnalysis(tripId, coordinates, analysis) {
  const state = (await tripStateManager.getTripState(tripId)) || {};
  state.lastMLAnalysis = {
    coordinates,
    result: analysis,
    analyzedAt: Date.now(),
  };
  await tripStateManager.setTripState(tripId, state);
}

async function getModelStats() {
  const weights = await loadWeights();
  const SafetyEvent = getSafetyEventModel();

  const stats = await SafetyEvent.aggregate([
    { $match: { "outcome.wasCorrectPrediction": { $exists: true } } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        correct: { $sum: { $cond: ["$outcome.wasCorrectPrediction", 1, 0] } },
      },
    },
  ]);

  return {
    weights,
    accuracy: stats[0]
      ? ((stats[0].correct / stats[0].total) * 100).toFixed(1) + "%"
      : "N/A",
    totalLearned: stats[0]?.total || 0,
  };
}

module.exports = {
  analyzeLocation,
  recordAnalysis,
  getModelStats,
  updateFromOutcome,
  RISK_RADIUS,
};
