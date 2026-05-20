const mongoose = require("mongoose");
const { getOrderDB } = require("../config/conectet");

/**
 * 1. SafetyEvent (Lightweight Core)
 * The primary record of a safety-relevant occurrence.
 */
const safetyEventSchema = new mongoose.Schema(
  {
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ["location", "behavior", "system", "external"],
      required: true,
      index: true,
    },
    riskScore: { type: Number, min: 0, max: 1, index: true },
    riskLevel: {
      type: String,
      enum: ["safe", "caution", "warning", "dangerous", "unknown"],
      default: "unknown",
    },
    location: {
      type: { type: String, default: "Point" },
      coordinates: { type: [Number], index: "2dsphere" },
    },
    decisionSummary: String,
    hasSnapshot: { type: Boolean, default: false },
    hasOutcome: { type: Boolean, default: false },
    participants: {
      tourist: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      guide: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
  },
  { timestamps: true },
);

/**
 * 2. SafetyAnalysisSnapshot (Detailed Snapshots)
 * Transient, large data stored only for high-risk or sampled events.
 */
const analysisSnapshotSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SafetyEvent",
      required: true,
      unique: true,
    },
    tripId: { type: mongoose.Schema.Types.ObjectId, index: true },
    layers: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
    },
    rawContext: mongoose.Schema.Types.Mixed,
    apiUsage: {
      googleMaps: Boolean,
      geminiAI: Boolean,
      responseTime: Number,
    },
    processingTimeMs: Number,
    modelVersion: String,
  },
  { timestamps: true },
);

// TTL Index for snapshots (30 days - Transient data)
analysisSnapshotSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

/**
 * 3. SafetyOutcome (Ground Truth & Verification)
 * Stores user responses and final verification of the event.
 */
const safetyOutcomeSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SafetyEvent",
      required: true,
      unique: true,
    },
    tripId: { type: mongoose.Schema.Types.ObjectId, index: true },
    userResponse: {
      responded: { type: Boolean, default: false },
      answer: mongoose.Schema.Types.Mixed,
      responseTime: Number,
      timestamp: Date,
    },
    finalVerdict: {
      verifiedSafe: Boolean,
      wasActualEmergency: Boolean,
      requiredIntervention: Boolean,
      wasCorrectPrediction: Boolean,
    },
    interventionDetails: String,
    closedBy: { type: String, enum: ["system", "admin", "user"] },
    closedAt: Date,
  },
  { timestamps: true },
);

// No TTL for outcomes - Legal and audit evidence

/**
 * 4. SafetyTrainingData (ML Learning Repository)
 * Raw data and labels - Python ML Brain does feature extraction during training
 */
const trainingDataSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SafetyEvent",
      required: true,
      unique: true,
    },
    // Raw data for Python ML Brain to process
    rawData: {
      coordinates: [Number],
      timestamp: Date,
      speed: Number,
      bearing: Number,
      deviceHealth: mongoose.Schema.Types.Mixed,
      distanceFromGuide: Number,
      tripId: String,
      serviceType: String,
      country: String,
      touristId: String,
      guideId: String,
    },
    // Legacy: pre-extracted features (for backward compatibility)
    features: [Number],
    label: Number, // Target outcome (0-1)
    weight: { type: Number, default: 1.0 },
    metadata: {
      userSentiment: Number,
      prefersFewerMessages: Boolean,
      tripType: String,
      analysisResult: String,
    },
  },
  { timestamps: true },
);

// TTL Index for training data (1 year - Balance history and storage)
trainingDataSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 365 * 24 * 60 * 60 },
);

/**
 * 5. LocationReputation (Geographic Intelligence)
 * The system's accumulated knowledge about specific locations.
 */
const locationReputationSchema = new mongoose.Schema(
  {
    locationName: { type: String, required: true },
    coordinates: {
      type: { type: String, default: "Point" },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    address: String,
    riskScore: Number,
    riskLevel: {
      type: String,
      enum: ["safe", "caution", "warning", "dangerous", "unknown"],
    },
    sentiment: String,
    reviews: [
      {
        author: String,
        text: String,
        rating: Number,
        time: Date,
        freshnessWeight: Number,
        localAnalysis: {
          isSuspicious: Boolean,
          flaggedKeywords: [String],
        },
      },
    ],
    aiVerdict: {
      summary: String,
      detectedRisks: [String],
      confidence: Number,
    },
    source: { type: String, default: "mixed" },
    checkedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

locationReputationSchema.index({ coordinates: "2dsphere" });
locationReputationSchema.index({ locationName: 1 });

// Model Retrieval Helpers
let Models = {};

function getModels() {
  if (Object.keys(Models).length === 0) {
    const orderDB = getOrderDB();
    Models.SafetyEvent = orderDB.model("SafetyEvent", safetyEventSchema);
    Models.SafetyAnalysisSnapshot = orderDB.model(
      "SafetyAnalysisSnapshot",
      analysisSnapshotSchema,
    );
    Models.SafetyOutcome = orderDB.model("SafetyOutcome", safetyOutcomeSchema);
    Models.SafetyTrainingData = orderDB.model(
      "SafetyTrainingData",
      trainingDataSchema,
    );
    Models.LocationReputation = orderDB.model(
      "LocationReputation",
      locationReputationSchema,
    );
  }
  return Models;
}

// Legacy compatibility wrapper (Phase 16 Transition)
function getSafetyEventModel() {
  return getModels().SafetyEvent;
}

module.exports = {
  getModels,
  getSafetyEventModel, // Keep for backward compatibility during refactor
  SafetyModels: Models, // Direct access
};
