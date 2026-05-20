/**
 * ML Brain System Configuration
 */

module.exports = {
  // Maturity Configuration
  maturity: {
    levels: {
      0: {
        name: "Infant",
        minEvents: 0,
        minAccuracy: 0,
        capabilities: ["observing"],
      },
      1: {
        name: "Learning",
        minEvents: 10000,
        minAccuracy: 0.6,
        capabilities: ["suggesting"],
      },
      2: {
        name: "Teen",
        minEvents: 50000,
        minAccuracy: 0.75,
        capabilities: ["assisting"],
      },
      3: {
        name: "Adult",
        minEvents: 100000,
        minAccuracy: 0.85,
        capabilities: ["independent_decisions"],
      },
      4: {
        name: "Expert",
        minEvents: 500000,
        minAccuracy: 0.95,
        capabilities: ["optimizing", "teaching"],
      },
    },
    updateIntervalHours: 24,
  },

  // Neural Network Architecture
  network: {
    inputFeatures: 27,
    hiddenLayers: [
      { units: 64, activation: "relu", dropout: 0.3 },
      { units: 32, activation: "relu", dropout: 0.2 },
      { units: 16, activation: "relu", dropout: 0.1 },
    ],
    outputUnits: 6, // [risk, use_map, use_ai, escalate, confidence, layer_override]
    learningRate: 0.001,
  },

  // Training Configuration
  training: {
    batchSize: 32,
    epochs: 50,
    validationSplit: 0.2,
    onlineLearningEnabled: true,
    dataFreshnessDays: 90,
    minEventsForTraining: 100,
  },

  // Safety & Fallback
  safety: {
    confidenceThreshold: 0.7,
    maxConsecutiveErrors: 5,
    abTestRatio: 0.1,
    minConfidenceForAutonomous: 0.75,
    emergencyOverrideThreshold: 0.8,
    maxRiskScore: 1.0,
    minRiskScore: 0.0,
    // 🆕 Safety Plan Thresholds
    plans: {
      free: {
        aiThreshold: 0.95, // High ceiling to minimize AI cost/intrusion
        escalationThreshold: 0.99, // Essentially manual check-ins only
        skipAnalysisIntervalMs: 5 * 60 * 1000, // 5 mins "Silent Guardian"
        disableAutoQuestions: true,
        maxGeofenceAlerts: 1,
      },
      premium: {
        aiThreshold: 0.5, // Proactive monitoring
        escalationThreshold: 0.7, // Standard safety protocols
        skipAnalysisIntervalMs: 0, // Real-time
        disableAutoQuestions: false,
        maxGeofenceAlerts: Infinity,
      },
    },
  },

  // Model Versioning
  model: {
    currentVersion: "1.1.0",
    versioningEnabled: true,
    maxVersionsToKeep: 5,
    autoRollbackOnFailure: true,
  },

  // Paths
  paths: {
    modelSavePath: "file://./models/mlBrain/model",
    checkpointPath: "file://./models/mlBrain/checkpoints",
    logsPath: "./logs/mlBrain",
  },

  // Feature Mapping (Indices in the input tensor)
  features: {
    LONGITUDE: 0,
    LATITUDE: 1,
    SPEED: 2,
    HOUR: 3,
    DAY_OF_WEEK: 4,
    BATTERY: 5,
    SIGNAL: 6,
    DISTANCE_FROM_GUIDE: 7,
    TRIP_DURATION: 8,
    HISTORICAL_RISK: 9,
    USER_RESPONSE_RATE: 10,
    PREVIOUS_INCIDENTS: 11,
    WEATHER: 12,
    COUNTRY_RISK: 13,
    TIME_SINCE_LAST_UPDATE: 14,
    USER_BEHAVIOR_PATTERN: 15,
    TRIP_TYPE: 16,
    CROWD_DENSITY: 17,
    NEARBY_EVENTS: 18,
    ROUTE_COMPLEXITY: 19,
    // 🆕 New features from Order & Review
    GUIDE_RATING: 20,
    GUIDE_SUCCESS_RATE: 21,
    GUIDE_REVIEW_RATING: 22,
    TOURIST_RATING: 23,
    DESTINATION_POPULARITY: 24,
    // 🆕 User Preferences from UX Feedback (Phase 14)
    USER_SENTIMENT: 25,
    PREFERS_FEWER_MESSAGES: 26,
  },
};
