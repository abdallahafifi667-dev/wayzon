/**
 * User Profile Service - خدمة ملف المستخدم الشامل
 *
 * يجمع بيانات تاريخية عن المستخدم من عدة مصادر:
 * - EmergencyAlert: حالات الطوارئ السابقة
 * - Chat: رسائل الطوارئ والتواصل
 * - Review: التقييمات والآراء
 * - TripFeedback: تعليقات ما بعد الرحلة
 *
 * يُستخدم لتحسين قرارات ML والتخصيص الذكي
 */

const {
  getEmergencyAlertModel,
} = require("../../models/emergencyAlert.models");
const { getChatModel } = require("../../models/Chat.models");
const { getUserReview } = require("../../models/Review.models");
const { getTripFeedbackModel } = require("../../models/tripFeedback.model");
const { getOrderModel } = require("../../models/order.models");
const { getUserModel, getUserKYCModel } = require("../../models/users.models");
const tripStateManager = require("../tripStateManager");
const { client: redis, connectRedis } = require("../../config/redis");
const { logger } = require("../../monitoring/metrics");

// Cache user profiles for 1 hour
const PROFILE_CACHE_TTL = 60 * 60;
const PROFILE_KEY_PREFIX = "user:profile:";

/**
 * Get comprehensive user profile for ML decisions
 * @param {string} userId - User ID
 * @param {string} role - 'tourist' or 'guide'
 * @returns {Object} Full user profile with behavioral patterns
 */
async function getUserProfile(userId, role = "tourist") {
  if (!userId) return getDefaultProfile(role);

  try {
    // 1. Check cache first
    const cached = await getCachedProfile(userId);
    if (cached) return cached;

    // 2. Aggregate data from all sources
    const [
      emergencyHistory,
      chatPatterns,
      reviewHistory,
      feedbackHistory,
      tripHistory,
      userData,
    ] = await Promise.all([
      getEmergencyHistory(userId),
      getChatPatterns(userId),
      getReviewHistory(userId),
      getFeedbackHistory(userId),
      getTripHistory(userId),
      getUserData(userId),
    ]);

    // 3. Build comprehensive profile
    const profile = {
      userId,
      role,
      updatedAt: new Date(),
      demographics: {
        age: userData.age,
        gender: userData.gender,
        languages: userData.languages,
      },

      // Trust & Risk Score
      trustScore: calculateTrustScore({
        emergencyHistory,
        reviewHistory,
        feedbackHistory,
        tripHistory,
      }),

      // Behavioral Patterns
      behavior: {
        // Emergency patterns
        hasEmergencyHistory: emergencyHistory.totalAlerts > 0,
        falseAlarmRate: emergencyHistory.falseAlarmRate,
        emergencyResponseRate: emergencyHistory.responseRate,
        lastEmergencyDays: emergencyHistory.daysSinceLastAlert,

        // Communication patterns
        chatResponseTime: chatPatterns.avgResponseTime,
        chatSentiment: chatPatterns.sentiment,
        usesEmergencyKeywords: chatPatterns.usesEmergencyKeywords,
        isResponsive: chatPatterns.responseRate > 0.7,

        // Review patterns
        avgRatingGiven: reviewHistory.avgRatingGiven,
        avgRatingReceived: reviewHistory.avgRatingReceived,
        isPositiveReviewer: reviewHistory.avgRatingGiven > 3.5,
        hasNegativeReviews: reviewHistory.negativeReviewsReceived > 0,
      },

      // Trip Experience
      experience: {
        totalTrips: tripHistory.totalTrips,
        completedTrips: tripHistory.completedTrips,
        cancelledTrips: tripHistory.cancelledTrips,
        isExperienced: tripHistory.completedTrips >= 5,
        completionRate: tripHistory.completionRate,
        avgTripDuration: tripHistory.avgDuration,
      },

      // ML Recommendations
      mlRecommendations: {
        monitoringIntensity: calculateMonitoringIntensity({
          emergencyHistory,
          feedbackHistory,
          tripHistory,
        }),
        skipLayers: [],
        extraLayers: [],
        alertThreshold: 0.5,
      },
    };

    // 4. Add ML recommendations based on profile
    enrichMLRecommendations(profile);

    // 5. Cache profile
    await cacheProfile(userId, profile);

    return profile;
  } catch (err) {
    logger.error("Failed to build user profile", {
      userId,
      error: err.message,
    });
    return getDefaultProfile(role);
  }
}

/**
 * Get emergency alert history for user
 */
async function getEmergencyHistory(userId) {
  try {
    const EmergencyAlert = getEmergencyAlertModel();
    const Order = getOrderModel();

    // ✅ Optimized: Single aggregation query instead of 2 separate queries
    const result = await Order.aggregate([
      {
        $match: {
          $or: [{ normal: userId }, { guide: userId }],
        },
      },
      {
        $lookup: {
          from: "emergencyalerts",
          localField: "_id",
          foreignField: "orderId",
          as: "alerts",
        },
      },
      {
        $unwind: {
          path: "$alerts",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $sort: { "alerts.createdAt": -1 },
      },
      {
        $limit: 50,
      },
      {
        $group: {
          _id: null,
          alerts: { $push: "$alerts" },
        },
      },
    ]);

    const alerts = result[0]?.alerts || [];

    if (!alerts.length) {
      return {
        totalAlerts: 0,
        falseAlarmRate: 0,
        responseRate: 1.0,
        daysSinceLastAlert: 999,
      };
    }

    // Analyze patterns
    const resolved = alerts.filter(
      (a) => a.status === "RESOLVED" || a.status === "DISMISSED",
    ).length;
    const dismissed = alerts.filter((a) => a.status === "DISMISSED").length;
    const responded = alerts.filter((a) =>
      a.systemResponses?.some((r) => r.response?.received),
    ).length;

    const lastAlert = alerts[0];
    const daysSince = Math.floor(
      (Date.now() - new Date(lastAlert.createdAt).getTime()) /
      (24 * 60 * 60 * 1000),
    );

    return {
      totalAlerts: alerts.length,
      falseAlarmRate: alerts.length > 0 ? dismissed / alerts.length : 0,
      responseRate: alerts.length > 0 ? responded / alerts.length : 1.0,
      daysSinceLastAlert: daysSince,
      lastAlertType: lastAlert.alertType,
      recentAlerts: alerts.slice(0, 3).map((a) => ({
        type: a.alertType,
        status: a.status,
        priority: a.priority,
        date: a.createdAt,
      })),
    };
  } catch (err) {
    logger.debug("Failed to get emergency history", {
      userId,
      error: err.message,
    });
    return {
      totalAlerts: 0,
      falseAlarmRate: 0,
      responseRate: 1.0,
      daysSinceLastAlert: 999,
    };
  }
}

/**
 * Analyze chat patterns for user behavior
 */
async function getChatPatterns(userId) {
  try {
    const Chat = getChatModel();

    // Get recent messages
    const messages = await Chat.find({
      $or: [{ from: userId }, { to: userId }],
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    if (!messages.length) {
      return {
        avgResponseTime: null,
        sentiment: "neutral",
        responseRate: 1.0,
        usesEmergencyKeywords: false,
      };
    }

    // Analyze response patterns
    const sentMessages = messages.filter(
      (m) => m.from.toString() === userId.toString(),
    );
    const receivedMessages = messages.filter(
      (m) => m.to.toString() === userId.toString(),
    );
    const respondedTo = receivedMessages.filter((m) => m.isRead).length;

    // Check for emergency keywords
    const emergencyRegex =
      /(help|emergency|sos|مساعدة|طوارئ|نجدة|خطر|danger|scared|afraid)/i;
    const hasEmergencyKeywords = sentMessages.some((m) =>
      emergencyRegex.test(m.message),
    );

    // Basic sentiment analysis
    const positiveRegex =
      /(great|thanks|good|excellent|ممتاز|شكرا|جيد|رائع|love|happy)/i;
    const negativeRegex =
      /(bad|terrible|awful|hate|سيء|كره|مشكلة|problem|angry|upset)/i;

    const positiveCount = sentMessages.filter((m) =>
      positiveRegex.test(m.message),
    ).length;
    const negativeCount = sentMessages.filter((m) =>
      negativeRegex.test(m.message),
    ).length;

    let sentiment = "neutral";
    if (positiveCount > negativeCount * 2) sentiment = "positive";
    else if (negativeCount > positiveCount * 2) sentiment = "negative";

    return {
      totalMessages: messages.length,
      avgResponseTime: null, // Would need timestamps analysis
      sentiment,
      responseRate:
        receivedMessages.length > 0
          ? respondedTo / receivedMessages.length
          : 1.0,
      usesEmergencyKeywords: hasEmergencyKeywords,
      recentEmergencyMentions: sentMessages
        .filter((m) => emergencyRegex.test(m.message))
        .slice(0, 3),
    };
  } catch (err) {
    logger.debug("Failed to get chat patterns", { userId, error: err.message });
    return {
      avgResponseTime: null,
      sentiment: "neutral",
      responseRate: 1.0,
      usesEmergencyKeywords: false,
    };
  }
}

/**
 * Get review history for user
 */
async function getReviewHistory(userId) {
  try {
    const Review = getUserReview();
    const Order = getOrderModel();

    // ✅ Optimized: Parallel queries instead of sequential
    const [reviewsGiven, userOrdersResult] = await Promise.all([
      Review.find({ user: userId }).lean(),
      Order.find({
        $or: [{ normal: userId }, { guide: userId }],
      })
        .select("_id")
        .lean(),
    ]);

    const orderIds = userOrdersResult.map((o) => o._id);
    const reviewsReceived = await Review.find({
      product: { $in: orderIds },
    }).lean();

    const avgGiven =
      reviewsGiven.length > 0
        ? reviewsGiven.reduce((sum, r) => sum + r.rating, 0) /
        reviewsGiven.length
        : 4.0;

    const avgReceived =
      reviewsReceived.length > 0
        ? reviewsReceived.reduce((sum, r) => sum + r.rating, 0) /
        reviewsReceived.length
        : 4.0;

    return {
      totalReviewsGiven: reviewsGiven.length,
      totalReviewsReceived: reviewsReceived.length,
      avgRatingGiven: avgGiven,
      avgRatingReceived: avgReceived,
      negativeReviewsReceived: reviewsReceived.filter((r) => r.rating <= 2)
        .length,
      recentReviews: reviewsReceived.slice(0, 3).map((r) => ({
        rating: r.rating,
        comment: r.comment?.slice(0, 100),
        date: r.createdAt,
      })),
    };
  } catch (err) {
    logger.debug("Failed to get review history", {
      userId,
      error: err.message,
    });
    return {
      avgRatingGiven: 4.0,
      avgRatingReceived: 4.0,
      negativeReviewsReceived: 0,
    };
  }
}

/**
 * Get feedback history from TripFeedback model
 */
async function getFeedbackHistory(userId) {
  try {
    const TripFeedback = getTripFeedbackModel();

    const feedbacks = await TripFeedback.find({
      $or: [{ fromUserId: userId }, { toUserId: userId }],
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const given = feedbacks.filter(
      (f) => f.fromUserId?.toString() === userId.toString(),
    );
    const received = feedbacks.filter(
      (f) => f.toUserId?.toString() === userId.toString(),
    );

    return {
      totalFeedbackGiven: given.length,
      totalFeedbackReceived: received.length,
      avgRatingGiven:
        given.length > 0
          ? given.reduce((sum, f) => sum + (f.rating || 0), 0) / given.length
          : 4.0,
      avgRatingReceived:
        received.length > 0
          ? received.reduce((sum, f) => sum + (f.rating || 0), 0) /
          received.length
          : 4.0,
      incidentCount: feedbacks.filter((f) => f.hadSafetyIncident).length,
      prefersFewerMessages: given.some(
        (f) => f.uxPreferences?.prefersFewerMessages,
      ),
    };
  } catch (err) {
    logger.debug("Failed to get feedback history", {
      userId,
      error: err.message,
    });
    return { avgRatingGiven: 4.0, avgRatingReceived: 4.0, incidentCount: 0 };
  }
}

/**
 * Get trip history statistics
 */
async function getTripHistory(userId) {
  try {
    const Order = getOrderModel();

    const trips = await Order.find({
      $or: [{ normal: userId }, { guide: userId }],
    })
      .select("status duration createdAt")
      .lean();

    const completed = trips.filter((t) => t.status === "completed").length;
    const cancelled = trips.filter((t) => t.status === "cancelled").length;

    // Use tripStateManager to calculate average travel distance if locations exist
    let totalDistance = 0;
    let tripsWithDistance = 0;

    trips.forEach((trip) => {
      if (trip.locations?.length > 1) {
        let tripDist = 0;
        for (let i = 0; i < trip.locations.length - 1; i++) {
          const d = tripStateManager.calculateDistance(
            trip.locations[i].coordinates,
            trip.locations[i + 1].coordinates,
          );
          tripDist += d;
        }
        totalDistance += tripDist;
        tripsWithDistance++;
      }
    });

    return {
      totalTrips: trips.length,
      completedTrips: completed,
      cancelledTrips: cancelled,
      completionRate: trips.length > 0 ? completed / trips.length : 1.0,
      avgDuration:
        trips.length > 0
          ? trips.reduce((sum, t) => sum + (t.duration || 0), 0) / trips.length
          : 0,
      avgTripDistance:
        tripsWithDistance > 0 ? totalDistance / tripsWithDistance : 0,
    };
  } catch (err) {
    logger.debug("Failed to get trip history", { userId, error: err.message });
    return { totalTrips: 0, completedTrips: 0, completionRate: 1.0 };
  }
}

/**
 * Get core user data (age, gender, etc.)
 */
async function getUserData(userId) {
  try {
    const User = getUserModel();
    const UserKYC = getUserKYCModel();

    const [user, kyc] = await Promise.all([
      User.findById(userId).lean(),
      UserKYC.findOne({ userId }).lean(),
    ]);

    if (!user) return { age: null, gender: null, languages: [] };

    return {
      age: kyc?.age || null,
      gender: kyc?.gender || user.gender || null,
      languages: user.languages?.map((l) => l.name) || [],
    };
  } catch (err) {
    logger.debug("Failed to get basic user data", {
      userId,
      error: err.message,
    });
    return { age: null, gender: null, languages: [] };
  }
}

/**
 * Calculate overall trust score (0-100)
 */
function calculateTrustScore({
  emergencyHistory,
  reviewHistory,
  feedbackHistory,
  tripHistory,
}) {
  let score = 50; // Start neutral

  // Emergency history impact (-20 to +10)
  if (emergencyHistory.totalAlerts === 0) {
    score += 10;
  } else {
    score -= Math.min(emergencyHistory.falseAlarmRate * 20, 15);
    if (emergencyHistory.daysSinceLastAlert < 30) score -= 5;
  }

  // Review impact (-15 to +15)
  if (reviewHistory.avgRatingReceived >= 4.5) score += 15;
  else if (reviewHistory.avgRatingReceived >= 4.0) score += 10;
  else if (reviewHistory.avgRatingReceived < 3.0) score -= 15;

  if (reviewHistory.negativeReviewsReceived >= 3) score -= 10;

  // Trip history impact (-10 to +15)
  if (tripHistory.completedTrips >= 10) score += 15;
  else if (tripHistory.completedTrips >= 5) score += 10;
  else if (tripHistory.completedTrips >= 2) score += 5;

  if (tripHistory.completionRate < 0.5) score -= 10;

  // Feedback impact (-10 to +10)
  if (feedbackHistory.incidentCount > 0)
    score -= feedbackHistory.incidentCount * 5;
  if (feedbackHistory.avgRatingReceived >= 4.0) score += 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate monitoring intensity based on profile
 */
function calculateMonitoringIntensity({
  emergencyHistory,
  feedbackHistory,
  tripHistory,
}) {
  // High risk indicators -> high monitoring
  if (
    emergencyHistory.totalAlerts >= 3 &&
    emergencyHistory.daysSinceLastAlert < 90
  ) {
    return "high";
  }
  if (feedbackHistory.incidentCount >= 2) {
    return "high";
  }

  // Low risk indicators -> low monitoring
  if (tripHistory.completedTrips >= 10 && tripHistory.completionRate >= 0.9) {
    return feedbackHistory.prefersFewerMessages ? "very_low" : "low";
  }
  if (tripHistory.completedTrips >= 5 && emergencyHistory.totalAlerts === 0) {
    return "low";
  }

  return "normal";
}

/**
 * Enrich profile with ML-specific recommendations
 */
function enrichMLRecommendations(profile) {
  const rec = profile.mlRecommendations;

  // Skip layers for trusted users
  if (profile.trustScore >= 75 && profile.experience.isExperienced) {
    rec.skipLayers.push("reputation_deep"); // Skip deep reputation checks
    rec.alertThreshold = 0.65; // Higher threshold before alerting
  }

  // Add extra layers for risky users
  if (profile.trustScore < 30 || profile.behavior.hasEmergencyHistory) {
    rec.extraLayers.push("video_analysis");
    rec.alertThreshold = 0.35; // Lower threshold = more alerts
  }

  // Adjust for communication patterns
  if (profile.behavior.isResponsive) {
    rec.skipLayers.push("repeated_notifications");
  } else {
    rec.extraLayers.push("guide_cc"); // CC guide on all alerts
  }

  // Negative review patterns
  if (profile.behavior.hasNegativeReviews) {
    rec.extraLayers.push("enhanced_monitoring");
  }
}

/**
 * Get default profile for unknown users
 */
function getDefaultProfile(role) {
  return {
    userId: null,
    role,
    isNewUser: true,
    trustScore: 50,
    behavior: {
      hasEmergencyHistory: false,
      falseAlarmRate: 0,
      isResponsive: true,
    },
    experience: {
      totalTrips: 0,
      isExperienced: false,
    },
    mlRecommendations: {
      monitoringIntensity: "normal",
      skipLayers: [],
      extraLayers: [],
      alertThreshold: 0.5,
    },
  };
}

/**
 * Cache helpers
 */
async function getCachedProfile(userId) {
  try {
    if (!redis.isOpen) await connectRedis();
    const cached = await redis.get(`${PROFILE_KEY_PREFIX}${userId}`);
    if (cached) {
      const profile = JSON.parse(cached);
      // Check if cache is still valid (1 hour)
      if (
        Date.now() - new Date(profile.updatedAt).getTime() <
        PROFILE_CACHE_TTL * 1000
      ) {
        return profile;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function cacheProfile(userId, profile) {
  try {
    if (!redis.isOpen) await connectRedis();
    await redis.setEx(
      `${PROFILE_KEY_PREFIX}${userId}`,
      PROFILE_CACHE_TTL,
      JSON.stringify(profile),
    );
  } catch (err) {
    logger.debug("Failed to cache user profile", {
      userId,
      error: err.message,
    });
  }
}

/**
 * Invalidate cache (call after major events)
 */
async function invalidateProfile(userId) {
  try {
    if (!redis.isOpen) await connectRedis();
    await redis.del(`${PROFILE_KEY_PREFIX}${userId}`);
  } catch (err) {
    logger.debug("Failed to invalidate profile cache", {
      userId,
      error: err.message,
    });
  }
}

/**
 * Get profiles for both trip participants
 */
async function getTripParticipantProfiles(tripDetails) {
  const [touristProfile, guideProfile] = await Promise.all([
    getUserProfile(tripDetails.normal, "tourist"),
    tripDetails.guide ? getUserProfile(tripDetails.guide, "guide") : null,
  ]);

  return {
    tourist: touristProfile,
    guide: guideProfile,
    // Combined risk assessment
    combinedTrustScore: guideProfile
      ? touristProfile.trustScore * 0.6 + guideProfile.trustScore * 0.4
      : touristProfile.trustScore,
    recommendedIntensity: selectCombinedIntensity(touristProfile, guideProfile),
  };
}

function selectCombinedIntensity(tourist, guide) {
  const intensityOrder = ["very_low", "low", "normal", "high"];
  const tIdx = intensityOrder.indexOf(
    tourist.mlRecommendations.monitoringIntensity,
  );
  const gIdx = guide
    ? intensityOrder.indexOf(guide.mlRecommendations.monitoringIntensity)
    : tIdx;

  // Use the higher intensity between tourist and guide
  return intensityOrder[Math.max(tIdx, gIdx)];
}

module.exports = {
  getUserProfile,
  getTripParticipantProfiles,
  invalidateProfile,
  // Expose sub-functions for testing
  getEmergencyHistory,
  getChatPatterns,
  getReviewHistory,
  getFeedbackHistory,
  getTripHistory,
};
