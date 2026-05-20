/**
 * Trip Feedback Service - خدمة تقييم ما بعد الرحلة
 *
 * يجمع التقييمات من المستخدمين بعد انتهاء الرحلة
 * يستخدم لتحسين نظام المراقبة تلقائياً
 */

const { getTripFeedbackModel } = require("../models/tripFeedback.model");
const tripStateManager = require("./tripStateManager");
const NotificationService = require("../controllers/Notification/notificationService");
const { getUserModel } = require("../models/users.models");
const { getOrderModel } = require("../models/order.models");
const { getSafetyEventModel } = require("../models/ml.model");
const { getIo, userSocketMap } = require("../socket");
const { logger } = require("../monitoring/metrics");
const dataCollector = require("./safety/dataCollector");

// Delay before sending feedback request
const FEEDBACK_DELAY_MS = 30 * 60 * 1000; // 30 minutes after trip completion

/**
 * Request feedback from both parties after trip completion
 * @param {string} tripId - Trip ID
 * @param {Object} tripDetails - Trip details
 */
async function requestFeedback(tripId, tripDetails) {
  // Get final trip state for metrics
  const tripState = await tripStateManager.getTripState(tripId);

  // Calculate trip metrics
  const metrics = calculateTripMetrics(tripState, tripDetails);

  // Determine if solo trip (no guide)
  const isSolo = tripDetails.tripType === "solo_system" || !tripDetails.guide;

  // Send to tourist (System/Solo feedback or Guide feedback)
  await sendFeedbackRequest(
    tripDetails.normal,
    tripId,
    tripDetails.guide,
    "tourist",
    metrics,
    isSolo,
  );

  // Send to guide (Only if NOT solo)
  if (!isSolo && tripDetails.guide) {
    await sendFeedbackRequest(
      tripDetails.guide,
      tripId,
      tripDetails.normal,
      "guide",
      metrics,
      false, // Guide always rates a tourist user
    );
  }

  logger.info("Feedback requests sent", { tripId });
}

/**
 * Schedule feedback request after delay
 */
async function scheduleFeedbackRequest(tripId, tripDetails) {
  const timerManager = require("./timerManager");

  timerManager.schedule(
    tripId,
    async () => {
      await requestFeedback(tripId, tripDetails);
    },
    FEEDBACK_DELAY_MS,
    "feedback_request",
  );

  logger.debug("Feedback request scheduled", {
    tripId,
    delayMs: FEEDBACK_DELAY_MS,
  });
}

/**
 * Send feedback request to a specific user
 */
async function sendFeedbackRequest(
  userId,
  tripId,
  aboutUserId,
  fromRole,
  metrics,
  isSolo = false,
) {
  const User = getUserModel();
  const io = getIo();

  // Handle optional aboutUser (null for Solo)
  const userPromise = User.findById(userId).select("fcmTokens username").lean();
  const aboutUserPromise = aboutUserId
    ? User.findById(aboutUserId).select("username profilePhoto").lean()
    : Promise.resolve(null);

  const [user, aboutUser] = await Promise.all([userPromise, aboutUserPromise]);

  const payload = {
    type: "feedback_request",
    tripId,
    aboutUserId: aboutUserId ? aboutUserId.toString() : null,
    aboutUserName: aboutUser?.username || "System",
    aboutUserPhoto: aboutUser?.profilePhoto,
    fromRole,
    isSolo,
    metrics: {
      durationMinutes: metrics.durationMinutes,
      wasOnTime: metrics.wasOnTime,
    },
    questions: getFeedbackQuestions(fromRole, isSolo),
    expiresIn: 72 * 60 * 60 * 1000, // 72 hours
  };

  // Socket notification
  const socketId = userSocketMap?.get(userId?.toString());
  if (socketId) {
    logger.debug("Emitting feedback questions via socket", {
      tripId,
      userId,
      socketId,
    });
    io.to(socketId).emit("feedback_request", payload);
  } else {
    logger.debug(
      "User not connected via socket, skipping socket feedback emission",
      { userId },
    );
  }

  // FCM notification
  if (user?.fcmTokens?.length) {
    const title = "🌟 How was your trip?";
    const body = isSolo
      ? "Share your feedback about the trip monitoring system"
      : `Share your thoughts on ${aboutUser?.username || "the trip"}`;

    await NotificationService.sendToMultipleDevices(
      user.fcmTokens,
      title,
      body,
      { tripId, type: "feedback_request" },
    );
  }
}

/**
 * Get feedback questions based on role
 */
function getFeedbackQuestions(role, isSolo = false) {
  // 1. SOLO / SYSTEM FEEDBACK (Reassurance & System Trust)
  if (isSolo && role === "tourist") {
    return [
      {
        id: "rating",
        type: "rating",
        question:
          "How was your overall experience with the Trip Monitoring System?",
        required: true,
      },
      {
        id: "safety_rating",
        type: "rating",
        question:
          "How do you rate the safety provided by the system during your solo trip?",
        required: true,
      },
      {
        id: "had_incident",
        type: "yes_no",
        question: "Did you encounter any safety issues during the trip?",
        required: true,
      },
      {
        id: "would_recommend",
        type: "yes_no",
        question: "Would you rely on this safety system again?",
        required: true,
      },
      {
        id: "ux_feedback",
        type: "text",
        question: "Any suggestions to improve our safety tracking?",
        required: false,
        maxLength: 500,
      },
    ];
  }

  // 2. STANDARD FEEDBACK (Guide <-> Tourist)
  const baseQuestions = [
    {
      id: "rating",
      type: "rating",
      question:
        role === "tourist"
          ? "How do you rate the Tour Guide?"
          : "How do you rate the Tourist?",
      required: true,
    },
    {
      id: "safety_rating",
      type: "rating",
      question: "How do you rate the safety level during the trip?",
      required: false,
    },
    {
      id: "behavior_flags",
      type: "multi_choice",
      question: "Which of these describe the person? (Select all that apply)",
      options: [
        { id: "punctual", label: "Punctual", positive: true },
        { id: "responsive", label: "Responsive", positive: true },
        { id: "professional", label: "Professional", positive: true },
        { id: "friendly", label: "Friendly", positive: true },
        ...(role === "tourist"
          ? [
            { id: "safe_driver", label: "Safe Driver", positive: true },
            { id: "followed_route", label: "Followed Route", positive: true },
            {
              id: "reckless_driving",
              label: "Reckless Driving",
              positive: false,
            },
            {
              id: "route_deviation",
              label: "Frequent Deviations",
              positive: false,
            },
          ]
          : []),
        { id: "slow_response", label: "Slow Response", positive: false },
        { id: "unresponsive", label: "Unresponsive", positive: false },
        {
          id: "uncomfortable",
          label: "Made me uncomfortable",
          positive: false,
        },
      ],
      required: false,
    },
    {
      id: "had_incident",
      type: "yes_no",
      question: "Did any safety incident occur during the trip?",
      required: true,
    },
    {
      id: "would_recommend",
      type: "yes_no",
      question:
        role === "tourist"
          ? "Would you recommend this guide to others?"
          : "Would you accept a trip request from this tourist again?",
      required: true,
    },
    {
      id: "comments",
      type: "text",
      question: "Any additional comments? (Optional)",
      required: false,
      maxLength: 500,
    },
    {
      id: "ux_feedback",
      type: "text",
      question:
        "What do you think about our tracking service? Any features you'd like to see?",
      required: false,
      maxLength: 500,
    },
  ];

  return baseQuestions;
}

/**
 * Submit feedback from user
 * @param {string} tripId - Trip ID
 * @param {string} userId - User submitting feedback
 * @param {Object} feedbackData - Feedback responses
 */
async function submitFeedback(tripId, userId, feedbackData) {
  const TripFeedback = getTripFeedbackModel();
  const Order = getOrderModel();

  // Get trip to determine roles
  const trip = await Order.findById(tripId)
    .select("normal guide tripType")
    .lean();
  if (!trip) {
    throw new Error("Trip not found");
  }

  const isSolo = trip.tripType === "solo_system" || !trip.guide;
  const isNormal = trip.normal.toString() === userId.toString();
  const fromRole = isNormal ? "tourist" : "guide";
  // For solo, toUserId is null (System feedback)
  const toUserId = isSolo ? null : isNormal ? trip.guide : trip.normal;

  // Get trip metrics
  const tripState = await tripStateManager.getTripState(tripId);
  const metrics = calculateTripMetrics(tripState, trip);

  // Extract basic preferences for ML (Phase 13) - Moved up to fix reference error
  const preferences = extractUXPreferences(feedbackData.ux_feedback);

  const feedback = new TripFeedback({
    tripId,
    fromUserId: userId,
    toUserId,
    fromRole,
    rating: feedbackData.rating,
    safetyRating: feedbackData.safety_rating,
    behaviorFlags: feedbackData.behavior_flags || [],
    comments: feedbackData.comments,
    uxFeedback: feedbackData.ux_feedback,
    sentimentScore: preferences.sentimentScore,
    uxPreferences: {
      prefersFewerMessages: preferences.prefersFewerMessages,
      wantedAdditions: preferences.wantedAdditions,
    },
    hadSafetyIncident:
      feedbackData.had_incident === true || feedbackData.had_incident === "yes",
    wouldRecommend:
      feedbackData.would_recommend === true ||
      feedbackData.would_recommend === "yes",
    tripMetrics: metrics,
    systemUseOnly: true,
  });

  await feedback.save();

  // Phase 18: Close ML loop for ALL events in this trip
  try {
    const { SafetyEvent } = require("../models/ml.model").getModels();
    const tripEvents = await SafetyEvent.find({ tripId }).select("_id").lean();

    const outcome = {
      verifiedSafe: !feedback.hadSafetyIncident && feedback.rating >= 3,
      wasActualEmergency: feedback.hadSafetyIncident && feedback.rating <= 2,
      requiredIntervention: feedback.hadSafetyIncident,
      wasCorrectPrediction: true, // Simplified for now
      finalAction: feedback.hadSafetyIncident
        ? "user_reported_incident"
        : "trip_completed_normally",
    };

    for (const event of tripEvents) {
      await dataCollector.recordOutcome(event._id, outcome);
    }
    logger.debug(
      `ML loop closed for ${tripEvents.length} events in trip ${tripId}`,
    );
  } catch (err) {
    logger.error("Failed to close ML loop for trip events", {
      tripId,
      error: err.message,
    });
  }

  // Sync feedback back to all SafetyEvents for this trip to close ML loop
  try {
    const SafetyEvent = getSafetyEventModel();
    await SafetyEvent.updateMany(
      { tripId },
      {
        $set: {
          "training.feedbackProvided": true,
          "training.userFinalRating": feedback.rating,
          "training.userTrustScoreDelta": feedback.calculatedSafetyScore - 50,
          "training.userPreferences": preferences,
        },
      },
    );
    logger.debug("SafetyEvents updated with user feedback labels", {
      tripId,
      rating: feedback.rating,
    });
  } catch (err) {
    logger.error("Failed to sync feedback to SafetyEvents", {
      tripId,
      error: err.message,
    });
  }

  logger.info("Feedback submitted", {
    tripId,
    fromRole,
    rating: feedback.rating,
    safetyScore: feedback.calculatedSafetyScore,
    flagged: feedback.flaggedForReview,
  });

  return {
    success: true,
    feedbackId: feedback._id,
    calculatedSafetyScore: feedback.calculatedSafetyScore,
  };
}

/**
 * Basic preference extraction from qualitative feedback (Phase 13)
 * @param {string} text - UX feedback text
 */
function extractUXPreferences(text) {
  if (!text)
    return {
      prefersFewerMessages: false,
      wantedAdditions: [],
      sentimentScore: 0.5,
    };

  const lowerText = text.toLowerCase();
  const preferences = {
    prefersFewerMessages: false,
    wantedAdditions: [],
    sentimentScore: 0.5,
  };

  // Keyword detection for "fewer messages"
  const messageKeywords = [
    "notifications",
    "fewer",
    "too many",
    "bother",
    "spam",
    "annoying",
    "رسائل أقل",
    "إزعاج",
    "كثير",
  ];
  if (messageKeywords.some((k) => lowerText.includes(k))) {
    preferences.prefersFewerMessages = true;
    preferences.sentimentScore -= 0.2;
  }

  // Keyword detection for positive sentiment
  const positiveKeywords = [
    "excellent",
    "good",
    "great",
    "love",
    "perfect",
    "amazing",
    "ممتاز",
    "جيد",
    "رائع",
  ];
  if (positiveKeywords.some((k) => lowerText.includes(k))) {
    preferences.sentimentScore += 0.3;
  }

  // Extract potential additions (basic)
  if (
    lowerText.includes("add") ||
    lowerText.includes("feature") ||
    lowerText.includes("إضافة")
  ) {
    const parts = text.split(/[.,\n]/);
    const additionPart = parts.find(
      (p) => p.includes("add") || p.includes("feature") || p.includes("إضافة"),
    );
    if (additionPart) preferences.wantedAdditions.push(additionPart.trim());
  }

  preferences.sentimentScore = Math.max(
    0,
    Math.min(1, preferences.sentimentScore),
  );
  return preferences;
}

/**
 * Calculate trip metrics from state
 */
function calculateTripMetrics(tripState, tripDetails) {
  if (!tripState) {
    return {
      durationMinutes: 0,
      totalDistance: 0,
      averageResponseTime: null,
      escalationCount: 0,
      routeDeviations: 0,
      wasOnTime: true,
    };
  }

  const startTime = tripDetails.execution?.startedAt || tripState?.startedAt || tripDetails.TripDate;
  const endTime = tripState.endedAt || Date.now();
  const durationMinutes = startTime
    ? Math.round((new Date(endTime) - new Date(startTime)) / 60000)
    : 0;

  return {
    durationMinutes,
    totalDistance: tripState.totalDistanceTraveled || 0,
    averageResponseTime: tripState.averageResponseTime || null,
    escalationCount: tripState.escalationCount || 0,
    routeDeviations: tripState.routeDeviationCount || 0,
    wasOnTime: tripState.wasOnTime !== false,
  };
}

/**
 * Get user's trust score for monitoring intensity
 * @param {string} userId - User ID
 * @returns {Object} Trust score and recommendation
 */
async function getUserTrustScore(userId) {
  const TripFeedback = getTripFeedbackModel();
  const trustData = await TripFeedback.getUserTrustScore(userId);

  // Determine monitoring intensity (Phase 14: Adaptive Personalization)
  let monitoringIntensity = "normal";
  if (trustData.trustScore < 30 || trustData.incidentCount >= 2) {
    monitoringIntensity = "high";
  } else if (trustData.trustScore >= 70 && trustData.totalFeedback >= 5) {
    // If trusted AND prefers fewer messages, go even lower
    monitoringIntensity = trustData.prefersFewerMessages ? "very_low" : "low";
  } else if (trustData.prefersFewerMessages && trustData.trustScore >= 50) {
    // Moderate trust but explicitly asked for fewer messages
    monitoringIntensity = "low";
  }

  return {
    ...trustData,
    monitoringIntensity,
    recommendation: getMonitoringRecommendation(monitoringIntensity),
  };
}

/**
 * Get monitoring recommendation based on intensity
 */
function getMonitoringRecommendation(intensity) {
  switch (intensity) {
    case "high":
      return {
        checkFrequency: "frequent",
        aiAnalysisThreshold: 0.3,
        escalationThreshold: 0.5,
        skipMLLayer: false,
      };
    case "low":
      return {
        checkFrequency: "reduced",
        aiAnalysisThreshold: 0.7,
        escalationThreshold: 0.8,
        skipMLLayer: true, // Trust ML more
      };
    case "very_low":
      return {
        checkFrequency: "minimal",
        aiAnalysisThreshold: 0.85,
        escalationThreshold: 0.9,
        skipMLLayer: true,
        throttleNonCritical: true, // New flag for orchestrator
      };
    default:
      return {
        checkFrequency: "normal",
        aiAnalysisThreshold: 0.5,
        escalationThreshold: 0.65,
        skipMLLayer: false,
      };
  }
}

/**
 * Get users that need attention (for admin dashboard)
 */
async function getConcerningUsers() {
  const TripFeedback = getTripFeedbackModel();
  return TripFeedback.getConcerningUsers();
}

/**
 * Check if user has pending feedback
 */
async function hasPendingFeedback(userId, tripId) {
  const TripFeedback = getTripFeedbackModel();
  const existing = await TripFeedback.findOne({
    tripId,
    fromUserId: userId,
  })
    .select("_id")
    .lean();

  return !existing;
}

module.exports = {
  requestFeedback,
  scheduleFeedbackRequest,
  submitFeedback,
  getUserTrustScore,
  getConcerningUsers,
  hasPendingFeedback,
  FEEDBACK_DELAY_MS,
};
