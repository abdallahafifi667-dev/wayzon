/**
 * Safety Orchestrator - المنسق الرئيسي لكل طبقات الأمان
 */

const mlAnalyzer = require("./safety/mlAnalyzer");
const mapVerifier = require("./safety/mapVerifier");
const aiAnalyzer = require("./safety/aiAnalyzer");
const escalationService = require("./safety/escalationService");
const distanceMonitor = require("./safety/distanceMonitor");
const speedAnalyzer = require("./safety/speedAnalyzer");
const timeSafetyAnalyzer = require("./safety/timeSafetyAnalyzer");
const videoRiskAnalyzer = require("./safety/videoRiskAnalyzer");
const routeMonitor = require("./safety/routeMonitor");
const dataCollector = require("./safety/dataCollector");
const locationReputationService = require("./safety/locationReputationService");
const mlBrain = require("./mlBrain");
const tripStateManager = require("./tripStateManager");
const timerManager = require("./timerManager");
const tripFeedbackService = require("./tripFeedbackService");
const flexibleResponseService = require("./flexibleResponseService");
const notificationQueueService = require("./notificationQueueService");
const NotificationService = require("../controllers/Notification/notificationService");
const { getUserModel } = require("../models/users.models");
const { getIo, userSocketMap } = require("../socket");
const { logger } = require("../monitoring/metrics");
const { getOrderModel } = require("../models/order.models");
const tripCompletionService = require("./tripCompletionService");
const predictiveSafety = require("./safety/helper/predictiveSafety");
const temporalRiskService = require("./safety/temporalRiskService");
const spatialRiskEngine = require("./safety/spatialRiskEngine");
const userProfileService = require("./safety/userProfileService");
const decisionOrchestrationService = require("./safety/decisionOrchestrationService");
const { getEmergencyAlertModel } = require("../models/emergencyAlert.models");
const billingClient = require("./billingClient");


/**
 * Initialize trip context - tracks visited locations and sets up monitoring state
 * This function is called once per analysis cycle to ensure proper context
 */
async function initializeTripContext(
  tripId,
  tripDetails,
  state,
  coordinates,
  role,
) {
  // Mark nearby locations as visited
  if (tripDetails.locations?.length) {
    for (let i = 0; i < tripDetails.locations.length; i++) {
      const loc = tripDetails.locations[i];
      if (!loc.visited) {
        const distance = tripStateManager.calculateDistance(
          coordinates,
          loc.coordinates,
        );
        if (distance < 50) {
          // Mark as visiting - actual visit mark is done by routeMonitor
          state.nearLocation = { index: i, name: loc.name, distance };
        }
      }
    }
  }

  // Initialize location history for ML if not exists
  if (!state.touristLocationHistory) {
    state.touristLocationHistory = [];
  }
  if (!state.guideLocationHistory) {
    state.guideLocationHistory = [];
  }

  // سجل المسار حسب من أرسل التحديث (سائح / مرشد) — لا يُستنتج من وجود guide في الطلب فقط
  const historyKey =
    role === "guide" ? "guideLocationHistory" : "touristLocationHistory";
  state[historyKey] = state[historyKey] || [];
  state[historyKey].push({
    coordinates,
    timestamp: Date.now(),
  });
  if (state[historyKey].length > 20) {
    state[historyKey].shift();
  }

  await tripStateManager.updateTripState(tripId, state);
}

async function shouldSkipAnalysis(
  tripId,
  role,
  coordinates,
  tripDetails,
  state,
) {
  // 1. Dual Monitoring Logic
  if (tripDetails.serviceType === "solo_system") {
    if (role === "guide") return { skip: true, reason: "solo_trip_no_guide" };
  } else if (role === "guide" && state.hasMet) {
    const touristLoc = state.lastTouristLocation;
    if (touristLoc) {
      const dist = tripStateManager.calculateDistance(coordinates, touristLoc);
      if (dist < 100) return { skip: true, reason: "guide_with_tourist" };
    }
  }

  // 2. Stationary & Safe Optimization (Phase 6)
  const stopDuration = state.stopStartTime
    ? Date.now() - state.stopStartTime
    : 0;
  if (stopDuration > 5 * 60 * 1000) {
    // Auto-completion check
    const completionCheck = await tripCompletionService.checkAutoCompletion(
      tripId,
      coordinates,
      tripDetails,
    );
    if (completionCheck.shouldComplete) {
      await tripCompletionService.completeTrip(tripId, completionCheck.reason);
      return { skip: true, reason: "trip_completed" };
    }

    // Safe Stop Detection: Skip deep analysis if stationary at a verified safe POI
    const isSafePlace =
      state.lastSafetyStatus === "safe" &&
      state.lastLocationType &&
      state.lastLocationType !== "unknown";
    if (isSafePlace) {
      const stopLoc =
        role === "guide" ? state.lastGuideLocation : state.lastTouristLocation;
      const distMoved = tripStateManager.calculateDistance(
        coordinates,
        stopLoc,
      );
      if (distMoved < 50)
        return { skip: true, reason: "stationary_safe_place" };
    }
  }

  // 3. Trust-Based Adaptive Throttling (Phase 14)
  const intensity = tripDetails.notificationRules?.[role] || "normal";
  const lastAnalysisTime = state.lastAnalysisTime || 0;
  const timeSinceLast = Date.now() - lastAnalysisTime;

  // Default intervals based on intensity (can be overridden by plan)
  const intensityIntervals = {
    high: 20000, // 20s
    normal: 60000, // 1 min
    low: 300000, // 5 mins
    very_low: 600000, // 10 mins
  };

  const minInterval =
    intensityIntervals[intensity] || intensityIntervals.normal;

  // Apply plan-based override if more restrictive
  const plan = tripDetails.safetyConfig?.plan || "free";
  const planConfig = mlBrain.config.safety.plans[plan];
  const planInterval = planConfig?.skipAnalysisIntervalMs || 0;

  const finalMinInterval = Math.max(minInterval, planInterval);

  if (timeSinceLast < finalMinInterval) {
    return { skip: true, reason: `adaptive_throttle_${intensity}` };
  }

  return { skip: false };
}

/**
 * Main Orchestrator Function
 */
async function processLocationUpdate(tripId, role, coordinates, tripDetails) {
  const timestamp = Date.now();
  const state = await tripStateManager.getOrCreateTripState(tripId);
  const Order = getOrderModel();
  const User = getUserModel();

  // Fetch fresh trip details to ensure we have the latest state (after controller update)
  const trip = await Order.findById(tripId).lean();
  if (!trip) {
    logger.error("Trip not found in orchestrator", { tripId });
    return { status: "error", reason: "trip_not_found" };
  }

  // ✅ Check and sync premium status (ensure 12h expiry is respected)
  const isPremium = await billingClient.checkPremiumStatus(trip.normal);

  // ✅ Detect downgrade during trip (if trip was premium but user no longer is)
  if (!isPremium && trip.safetyConfig?.plan === 'premium' && trip.safetyMode !== 'free') {
    await handlePremiumDowngrade(tripId, trip.normal);
    // Refresh trip object after update
    const updatedTrip = await Order.findById(tripId).lean();
    Object.assign(trip, updatedTrip);
  }

  // ✅ Detect safety mode and update Order if not set
  if (!trip.safetyMode) {
    const safetyMode = await billingClient.getUserSafetyMode(trip.normal);
    await Order.updateOne(
      { _id: tripId },
      {
        safetyMode,
        adSupported: safetyMode === 'free'
      }
    );
    logger.info("Safety mode set for trip", { tripId, safetyMode, adSupported: safetyMode === 'free' });
  }

  // Rename variable for compatibility with existing logic that uses tripDetails
  const currentTripDetails = trip;

  // Fetch user details once to enrich context and avoid multiple DB calls downstream
  const [touristUser, guideUser] = await Promise.all([
    User.findById(currentTripDetails.normal)
      .select("username fcmTokens")
      .lean(),
    currentTripDetails.guide
      ? User.findById(currentTripDetails.guide)
        .select("username fcmTokens")
        .lean()
      : null,
  ]);

  // Attach names and details for services (like escalation and reputation) that need them
  currentTripDetails.touristName = touristUser?.username;
  currentTripDetails.guideName = guideUser?.username;
  currentTripDetails.touristFCM = touristUser?.fcmTokens;
  currentTripDetails.guideFCM = guideUser?.fcmTokens;

  // Initial State Update (always track location)
  await tripStateManager.updateLocation(tripId, role, coordinates);

  // Phase 6 Check: Should we skip deep analysis?
  const optimization = await shouldSkipAnalysis(
    tripId,
    role,
    coordinates,
    currentTripDetails,
    state,
  );
  if (optimization.skip) {
    return {
      status: "optimized",
      reason: optimization.reason,
      layer: "monitor_only",
    };
  }

  // Update last analysis time for optimization tracking
  await tripStateManager.updateTripState(tripId, {
    lastAnalysisTime: timestamp,
  });

  // Layer 9: Mark visited locations
  await initializeTripContext(
    tripId,
    currentTripDetails,
    state,
    coordinates,
    role,
  );

  // Phase 14 Update: Adaptive Trust Monitoring
  // Fetch and cache trust scores/intensity if not already in state
  if (!state.trustMonitoring) {
    try {
      const [touristTrust, guideTrust] = await Promise.all([
        tripFeedbackService.getUserTrustScore(currentTripDetails.normal),
        currentTripDetails.guide
          ? tripFeedbackService.getUserTrustScore(currentTripDetails.guide)
          : null,
      ]);

      const trustMonitoring = {
        tourist: touristTrust,
        guide: guideTrust,
      };

      await tripStateManager.updateTripState(tripId, { trustMonitoring });
      state.trustMonitoring = trustMonitoring;
    } catch (err) {
      logger.error("Failed to fetch trust scores", {
        tripId,
        error: err.message,
      });
    }
  }

  // Inject intensity rules into tripDetails for downstream layers
  currentTripDetails.notificationRules = {
    tourist: state.trustMonitoring?.tourist?.monitoringIntensity || "normal",
    guide: state.trustMonitoring?.guide?.monitoringIntensity || "normal",
  };
  currentTripDetails.trustRecommendations = {
    tourist: state.trustMonitoring?.tourist?.recommendation,
    guide: state.trustMonitoring?.guide?.recommendation,
  };

  // Phase 14+: Fetch comprehensive user profile for personalization (Personalized Alternatives)
  const userProfile = await userProfileService.getUserProfile(
    role === "guide" ? currentTripDetails.guide : currentTripDetails.normal,
    role === "guide" ? "guide" : "tourist",
  );
  currentTripDetails.userProfile = userProfile;

  // 2. Core Analysis Results Container
  const analysisResults = { timestamp };

  // 3. Layer 2: Spatial & Route Intelligence (Holistic)
  analysisResults.spatial = await spatialRiskEngine.analyzeSpatialRisk(
    coordinates,
    currentTripDetails,
    userProfile,
  );

  // 4. Movement Analysis (Speed & Route)
  const movement = await runMovementAnalysis(
    tripId,
    role,
    coordinates,
    timestamp,
    currentTripDetails,
    state,
  );
  Object.assign(analysisResults, movement);

  // 5. Layer 1: Temporal Risk & Legal Compliance
  analysisResults.temporal = await temporalRiskService.analyzeTemporalRisk(
    currentTripDetails,
    coordinates,
  );

  // 6. ML & Advanced Brain Decisions
  const brains = await runBrainLayers(
    tripId,
    role,
    coordinates,
    currentTripDetails,
    state,
    analysisResults,
  );
  Object.assign(analysisResults, brains);

  // 7. Layer 3: Decision Orchestration (Playbooks)
  return await handleOrchestratedDecision(
    tripId,
    role,
    coordinates,
    currentTripDetails,
    state,
    analysisResults,
  );
}

/**
 * Layer 6 & 9: Movement Analysis
 */
async function runMovementAnalysis(
  tripId,
  role,
  coordinates,
  timestamp,
  tripDetails,
  state,
) {
  const results = {};
  results.speed = await speedAnalyzer.analyzeSpeedWithVehicle(
    tripId,
    role,
    coordinates,
    timestamp,
    tripDetails,
  );

  if (
    (state.hasMet || tripDetails.serviceType === "solo_system") &&
    role === "tourist"
  ) {
    // 🆕 Skip off-route alerts for "undefined" destinations (Exploration mode)
    if (tripDetails.destinationStatus === "undefined") {
      results.route = { status: "exploring", reason: "undefined_destination" };
    } else {
      let route = await routeMonitor.checkRoute(
        tripId,
        coordinates,
        tripDetails,
      );
      if (route.status === "off_route") {
        const headingToOther = await routeMonitor.isOnRouteToAnyLocation(
          coordinates,
          tripDetails.locations || [],
        );
        if (headingToOther.isOnRoute) {
          route = {
            ...route,
            status: "re_routing",
            isShortcut: true,
            headingTo: headingToOther.nearest.name,
          };
        }
      }
      results.route = route;
    }
  }
  return results;
}

/**
 * ML & Advanced Brain Layers
 */
async function runBrainLayers(
  tripId,
  role,
  coordinates,
  tripDetails,
  state,
  analysisResults,
) {
  const ml = await mlAnalyzer.analyzeLocation(tripId, coordinates, role);
  await mlAnalyzer.recordAnalysis(tripId, coordinates, ml);

  ml.speedContext = analysisResults.speed;
  ml.timeContext = analysisResults.time;

  // Distance checks only apply to guided trips
  let distanceContext = { skip: true, reason: "solo_trip" };
  if (tripDetails.serviceType !== "solo_system") {
    const distance = await distanceMonitor.checkDistance(tripId, tripDetails);
    const rapid = await distanceMonitor.checkRapidSeparation(
      tripId,
      coordinates,
      distance.contextMultiplier || 1,
    );

    if (rapid.rapidSeparation && rapid.shouldAlert) {
      distance.needsVetting = true;
      distance.level = "critical";
      distance.reason = "rapid_separation";
    }
    distanceContext = { ...distance, rapidSeparation: rapid };
  }
  ml.distanceContext = distanceContext;

  // Layer 5: Dynamic Video Intelligence (Phase 5 & 12)
  // Only triggers if "suspicion" exists (Dynamic Trigger)
  const videoRisk = await videoRiskAnalyzer.analyzeAreaRisks(coordinates, {
    country: tripDetails.country,
    hasDeviation: results.route?.status === "off_route",
    mlRiskLevel: ml.riskLevel,
    spatialRiskElevated: results.spatial?.shouldTriggerVideo, // 🆕 Combined Spatial Intelligence
    stoppedSuspiciously: results.stoppedDuration > 300000, // 5 mins
    userId: tripDetails.normal,
  });

  // Merge video intelligence into ML context
  if (videoRisk.status === "analyzed" || videoRisk.status === "cached_risk") {
    ml.videoContext = videoRisk;
    // If confirmed video threat, override risk level to danger
    if (videoRisk.riskLevel === "danger") {
      ml.riskLevel = "danger";
      ml.riskScore = Math.max(ml.riskScore, 0.95);
    }
  }

  const brainProposal = await mlBrain.getSafetyProposal(
    {
      ...coordinates,
      role,
      speed: analysisResults.speed?.speed,
      deviceHealth: state.deviceHealth,
    },
    tripDetails,
  );

  // Layer 12: Predictive Future Vector Analysis (New)
  // Only run if moving reasonably fast (> 10 km/h) to avoid noise
  let predictiveRisk = null;
  const speedKmh = analysisResults.speed?.speed || 0;

  if (speedKmh > 10 && analysisResults.speed?.bearing) {
    predictiveRisk = await predictiveSafety.analyzeFutureVector(
      tripId,
      coordinates,
      speedKmh,
      analysisResults.speed.bearing,
      tripDetails,
    );

    if (predictiveRisk.status === "future_risk_detected") {
      // Log & queue notification
      logger.warn("Predictive Safety: Future risk detected", {
        tripId,
        risk: predictiveRisk.riskLevel,
      });

      const targetUserId =
        role === "guide" ? tripDetails.guide : tripDetails.normal;
      await notificationQueueService.queueNotification({
        userId: targetUserId,
        title: "⚠️ Predictive Warning",
        body: `You are heading towards ${predictiveRisk.riskDetails.locationName} which has safety concerns.`,
        priority: "HIGH",
        data: {
          tripId,
          type: "predictive_warning",
          recommendation: predictiveRisk.recommendation
            ? `We suggest heading to ${predictiveRisk.recommendation[0]?.name}`
            : "Please change your route",
        },
      });
    }
  }

  return {
    ml,
    brainProposal,
    distance: distanceContext,
    videoRisk,
    predictive: predictiveRisk,
  };
}

/**
 * New Orchestrated Decision Handler
 * Uses decisionOrchestrationService to choose the correct playbook.
 */
async function handleOrchestratedDecision(
  tripId,
  role,
  coordinates,
  tripDetails,
  state,
  results,
) {
  const { ml, temporal, spatial, predictive } = results;

  // 1. Determine if we need the AI strategic layer (External AI)
  // Adjusted thresholds based on User Trust (Phase 14)
  const recommendation = tripDetails.trustRecommendations?.[role];
  const aiThreshold = recommendation?.aiAnalysisThreshold || 0.5;

  let aiVerdict = null;
  const needsAI =
    ml.confidence < aiThreshold ||
    ml.riskLevel !== "safe" ||
    spatial.riskLevel === "high" ||
    temporal.riskLevel === "high";

  if (needsAI) {
    // Run AI Analysis for strategic confirmation
    const mapResult = await mapVerifier.verifyLocation(coordinates, {
      tripDetails,
      role,
    });
    const aiResponse = await runAILayer(
      tripId,
      coordinates,
      role,
      ml,
      mapResult,
      tripDetails,
      state,
      results.spatial?.safeAlternatives,
    );
    aiVerdict = aiResponse.details;
    results.ai = aiResponse;
  }

  // 2. Delegate to Decision Orchestrator to choose and execute Playbook
  const decision = await decisionOrchestrationService.orchestrateDecision(
    {
      mlResult: ml,
      temporalRisk: temporal,
      spatialRisk: spatial,
      aiVerdict: aiVerdict,
    },
    tripId,
    tripDetails,
  );

  // 3. Collect data for persistence/tracing
  await collectAndTrace(tripId, coordinates, tripDetails, results);

  // 4. Update state for optimization
  await tripStateManager.updateTripState(tripId, {
    lastSafetyStatus: decision.playbook === "PROCEED" ? "safe" : "unsafe",
    lastPlaybook: decision.playbook,
  });

  // Return format compatible with existing controllers
  return {
    status: decision.playbook === "PROCEED" ? "safe" : "monitored",
    decision: {
      ...decision,
      playbook: ml.action || decision.playbook, // 🆕 Executive Brain Override
      strategicJustification: ml.strategicConsultation?.reasoning_en // 🆕 Strategic context
    },
    ml: ml,
    temporal: temporal,
    spatial: spatial,
    ai: results.ai,
  };
}

/**
 * Layer 3: AI Contextual Analysis
 */
async function runAILayer(
  tripId,
  coordinates,
  role,
  mlResult,
  mapResult,
  tripDetails,
  state,
  safeAlternatives = [],
) {
  const stoppedDuration = await detectStopDuration(tripId, role, coordinates);
  const previousLocations = await getPreviousLocations(tripId, role);
  const reputationHistory =
    await locationReputationService.getReputationHistory(tripId);
  const reverseResult = await mapVerifier.reverseGeocode(coordinates);
  const tripProgress = await routeMonitor.getTripProgress(tripId, tripDetails);

  const aiResult = await aiAnalyzer.analyzeContext({
    coordinates,
    role,
    mlAnalysis: mlResult,
    mapVerification: mapResult,
    tripDetails,
    stoppedDuration,
    reputationHistory,
    tripProgress,
    address: reverseResult.address,
    distanceAnalysis: mlResult.distanceContext,
    previousLocations,
    userProfile: tripDetails.userProfile,
    safeAlternatives,
  });

  const plan = tripDetails.safetyConfig?.plan || "free";
  const planConfig = mlBrain.config.safety.plans[plan];

  if (aiResult.shouldAskUser && !state.pendingResponse) {
    // Silent Guardian logic: Only ask if plan allows OR if it's an extreme emergency
    const isExtremeDanger =
      aiResult.riskLevel === "danger" || aiResult.riskLevel === "dangerous";
    const canAsk = !planConfig?.disableAutoQuestions || isExtremeDanger;

    if (canAsk) {
      const targetUserId =
        role === "guide" ? tripDetails.guide : tripDetails.normal;
      await flexibleResponseService.sendQuestion(tripId, targetUserId, {
        type: aiResult.questionType || "yes_no",
        question: aiResult.questionToAsk,
        priority: isExtremeDanger ? "urgent" : "high",
      });
    } else {
      logger.info("Skipping AI question for free plan (Silent Guardian)", {
        tripId,
        riskLevel: aiResult.riskLevel,
      });
    }
  }

  if (aiResult.shouldEscalate) {
    await escalationService.escalateToAdmin(tripId, {
      coordinates,
      role,
      reason: aiResult.escalationReason,
      tripDetails,
      aiAnalysis: aiResult,
      mapVerification: mapResult,
    });
  }

  return {
    status: aiResult.riskLevel,
    layer: "ai",
    details: aiResult,
    questionSent: !!aiResult.shouldAskUser,
    escalated: !!aiResult.shouldEscalate,
  };
}

async function checkMeetingPoint(tripId, tripDetails) {
  const distance = await tripStateManager.getDistance(tripId);

  if (distance !== null && distance < 50) {
    const state = await tripStateManager.getTripState(tripId);
    if (!state?.hasMet) {
      await tripStateManager.setMeetingStatus(tripId, true);

      const User = getUserModel();
      const [tourist, guide] = await Promise.all([
        User.findById(tripDetails.normal).select("fcmTokens").lean(),
        User.findById(tripDetails.guide).select("fcmTokens").lean(),
      ]);

      const message =
        "Great! You've met with your trip partner. Enjoy your trip!";
      const notifications = [];

      if (tourist?.fcmTokens?.length) {
        notifications.push(
          NotificationService.sendToMultipleDevices(
            tourist.fcmTokens,
            "Trip Started",
            message,
            { tripId, type: "meeting_confirmed" },
          ),
        );
      }
      if (guide?.fcmTokens?.length) {
        notifications.push(
          NotificationService.sendToMultipleDevices(
            guide.fcmTokens,
            "Trip Started",
            message,
            { tripId, type: "meeting_confirmed" },
          ),
        );
      }

      await Promise.allSettled(notifications);

      return true;
    }
  }
  return false;
}

/**
 * Helper to collect data and store event ID for later reference (like user responses)
 */
async function collectAndTrace(
  tripId,
  coordinates,
  tripDetails,
  analysisResults,
) {
  const eventId = await dataCollector.collectAnalysisData(
    tripId,
    coordinates,
    tripDetails,
    analysisResults,
  );
  if (eventId) {
    await tripStateManager.updateTripState(tripId, { lastEventId: eventId });
  }
  return eventId;
}

async function detectStopDuration(tripId, role, currentCoordinates) {
  const state = (await tripStateManager.getTripState(tripId)) || {};
  const locationKey =
    role === "guide" ? "lastGuideLocation" : "lastTouristLocation";

  if (!state[locationKey]) return 0;

  const distance = tripStateManager.calculateDistance(
    state[locationKey],
    currentCoordinates,
  );

  if (distance < 30) {
    if (!state.stopStartTime) {
      state.stopStartTime = Date.now();
      await tripStateManager.setTripState(tripId, state);
    }
    return Date.now() - state.stopStartTime;
  }

  state.stopStartTime = null;
  await tripStateManager.setTripState(tripId, state);
  return 0;
}

async function getPreviousLocations(tripId, role) {
  const state = await tripStateManager.getTripState(tripId);
  const key =
    role === "guide" ? "guideLocationHistory" : "touristLocationHistory";
  return state?.[key] || [];
}

async function sendSecondWarning(tripId, tripDetails) {
  const state = await tripStateManager.getTripState(tripId);
  const targetUserId = state?.pendingResponse?.sentTo;

  if (!targetUserId) return;

  const User = getUserModel();
  const io = getIo();
  const user = await User.findById(targetUserId).select("fcmTokens").lean();

  const message =
    "⚠️ URGENT: Please respond to confirm your safety. We are monitoring your trip.";

  const socketId = userSocketMap?.get(targetUserId.toString());
  if (socketId) {
    io.to(socketId).emit("urgent_safety_check", { tripId, message });
  }

  if (user?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      user.fcmTokens,
      "⚠️ Urgent Safety Check",
      message,
      { tripId, type: "urgent_safety", priority: "high" },
    );
  }

  await tripStateManager.setEscalationLevel(
    tripId,
    escalationService.ESCALATION_LEVELS.SECOND_WARNING,
  );
  await tripStateManager.setPendingResponse(
    tripId,
    "urgent_check",
    targetUserId,
  );

  timerManager.schedule(
    tripId,
    async () => {
      const checkState = await tripStateManager.getTripState(tripId);
      if (checkState?.pendingResponse?.type === "urgent_check") {
        await escalationService.escalateToAdmin(tripId, {
          coordinates:
            checkState?.lastTouristLocation || checkState?.lastGuideLocation,
          role:
            checkState?.pendingResponse?.sentTo === tripDetails.guide
              ? "guide"
              : "tourist",
          reason: "no_response_to_urgent_safety_check",
          tripDetails,
          responseHistory: checkState?.responseHistory,
        });
      }
    },
    60 * 1000,
    "urgent_response_timeout",
  );
}

async function processUserResponse(tripId, userId, response) {
  // Delegate entirely to Flexible Response Service
  return await flexibleResponseService.processResponse(
    tripId,
    userId,
    response,
  );
}

async function getTripDetails(tripId) {
  const Order = getOrderModel();
  return Order.findById(tripId).lean();
}

async function handlePremiumDowngrade(tripId, userId) {
  const Order = getOrderModel();
  const trip = await Order.findById(tripId);
  if (!trip || trip.safetyMode === "free") return;

  logger.warn("Downgrading active trip safety mode", { tripId, userId });

  // Update trip configuration
  await Order.updateOne(
    { _id: tripId },
    {
      $set: {
        safetyMode: "free",
        adSupported: true,
        "safetyConfig.plan": "free",
      },
      $push: {
        "execution.events": {
          type: "SAFETY_DOWNGRADE",
          timestamp: new Date(),
          details: "Premium session expired or credits exhausted during trip.",
        },
      },
    },
  );

  // Notify user through flexibleResponseService or directly
  await flexibleResponseService.sendQuestion(tripId, userId, {
    type: "info_only",
    template: "SAFETY_DOWNGRADE_NOTICE",
    question:
      "Your trip security monitoring has been moved to the Standard Plan. Some premium safety features may be limited.",
  });
}

module.exports = {
  processLocationUpdate,
  processUserResponse,
  checkMeetingPoint,
  sendSecondWarning,
  getTripDetails,
  handlePremiumDowngrade,
};
