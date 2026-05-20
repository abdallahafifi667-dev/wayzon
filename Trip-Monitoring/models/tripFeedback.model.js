/**
 * Trip Feedback Model - نموذج تقييم ما بعد الرحلة
 * مجموعة منفصلة لتخزين تقييمات المستخدمين للاستخدام الداخلي فقط
 */

const mongoose = require("mongoose");
const { getOrderDB } = require("../config/conectet");

const tripFeedbackSchema = new mongoose.Schema(
  {
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    fromRole: {
      type: String,
      enum: ["tourist", "guide"],
      required: true,
    },

    // Main rating (1-5 stars)
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },

    // Safety-specific rating (1-5)
    safetyRating: {
      type: Number,
      min: 1,
      max: 5,
    },

    // Behavior flags (multiple choice)
    behaviorFlags: [
      {
        type: String,
        default: [],
        enum: [
          // Positive flags
          "punctual", // التزم بالوقت
          "responsive", // استجاب للرسائل
          "professional", // محترف
          "friendly", // ودود
          "helpful", // مساعد
          "safe_driver", // سائق آمن
          "followed_route", // التزم بالمسار
          "good_communication", // تواصل جيد

          // Neutral flags
          "slow_response", // بطيء في الرد
          "late", // متأخر
          "changed_route", // غير المسار

          // Negative flags (for monitoring)
          "unresponsive", // لم يستجب
          "ignored_warnings", // تجاهل التحذيرات
          "reckless_driving", // قيادة متهورة
          "left_alone", // تركني وحيداً
          "suspicious", // تصرف مشبوه
          "uncomfortable", // شعرت بعدم ارتياح
          "route_deviation", // انحراف مقلق عن المسار
          "aggressive", // عدواني
          "unsafe", // غير آمن
        ],
      },
    ],

    // Free text comments (optional)
    comments: {
      type: String,
      maxlength: 1000,
    },

    // UX and Tracking Service feedback (Phase 13)
    uxFeedback: {
      type: String,
      maxlength: 1000,
    },

    // System-calculated safety score (0-100)
    calculatedSafetyScore: {
      type: Number,
      min: 0,
      max: 100,
    },

    // Was there any safety incident during the trip?
    hadSafetyIncident: {
      type: Boolean,
      default: false,
    },

    // Would you recommend this person?
    wouldRecommend: {
      type: Boolean,
    },

    // Trip metrics at the time of feedback
    tripMetrics: {
      durationMinutes: Number,
      totalDistance: Number,
      averageResponseTime: Number, // Response time to safety checks
      escalationCount: Number,
      routeDeviations: Number,
    },

    // Extracted UX preferences (Phase 13/14)
    sentimentScore: { type: Number, min: 0, max: 1, default: 0.5 },
    uxPreferences: {
      prefersFewerMessages: { type: Boolean, default: false },
      wantedAdditions: [String],
    },

    // Flag for system attention
    flaggedForReview: {
      type: Boolean,
      default: false,
    },
    flagReason: String,

    // This is for internal system use only
    systemUseOnly: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Indexes for efficient querying
tripFeedbackSchema.index({ toUserId: 1, createdAt: -1 });
tripFeedbackSchema.index({ behaviorFlags: 1 });
tripFeedbackSchema.index({ flaggedForReview: 1 });
tripFeedbackSchema.index({ calculatedSafetyScore: -1 });
tripFeedbackSchema.index({ tripId: 1, fromUserId: 1 }, { unique: true });

// Partial index for flagged items (Enterprise Optimization)
tripFeedbackSchema.index(
  { toUserId: 1 },
  { partialFilterExpression: { flaggedForReview: true } },
);

// Auto-calculate safety score before save
tripFeedbackSchema.pre("save", function (next) {
  // 1. Prevent self-rating (Security)
  if (
    this.toUserId &&
    this.fromUserId.toString() === this.toUserId.toString()
  ) {
    return next(new Error("Users cannot provide feedback for themselves"));
  }

  if (
    this.isModified("behaviorFlags") ||
    this.isModified("rating") ||
    this.isModified("safetyRating")
  ) {
    this.calculatedSafetyScore = calculateSafetyScore(this);

    // Flag for review if concerning
    if (this.calculatedSafetyScore < 40 || this.hadSafetyIncident) {
      this.flaggedForReview = true;
      this.flagReason = this.hadSafetyIncident
        ? "safety_incident_reported"
        : "low_safety_score";
    }
  }
  next();
});

/**
 * Calculate safety score from feedback
 */
function calculateSafetyScore(feedback) {
  let score = 50; // Base score

  // Rating contribution (±20)
  score += (feedback.rating - 3) * 10;

  // Safety rating contribution (±15)
  if (feedback.safetyRating) {
    score += (feedback.safetyRating - 3) * 7.5;
  }

  // Behavior flags
  const positiveFlags = [
    "punctual",
    "responsive",
    "professional",
    "friendly",
    "helpful",
    "safe_driver",
    "followed_route",
    "good_communication",
  ];
  const negativeFlags = [
    "unresponsive",
    "ignored_warnings",
    "reckless_driving",
    "left_alone",
    "suspicious",
    "uncomfortable",
    "route_deviation",
    "aggressive",
    "unsafe",
  ];

  for (const flag of feedback.behaviorFlags || []) {
    if (positiveFlags.includes(flag)) score += 3;
    if (negativeFlags.includes(flag)) score -= 8;
  }

  // Would recommend bonus
  if (feedback.wouldRecommend === true) score += 5;
  if (feedback.wouldRecommend === false) score -= 10;

  // Safety incident penalty
  if (feedback.hadSafetyIncident) score -= 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Static method to get aggregate score for a user
tripFeedbackSchema.statics.getUserTrustScore = async function (userId) {
  const result = await this.aggregate([
    { $match: { toUserId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: "$toUserId",
        avgRating: { $avg: "$rating" },
        avgSafetyRating: { $avg: "$safetyRating" },
        avgCalculatedScore: { $avg: "$calculatedSafetyScore" },
        totalFeedback: { $sum: 1 },
        incidentCount: { $sum: { $cond: ["$hadSafetyIncident", 1, 0] } },
        recommendCount: { $sum: { $cond: ["$wouldRecommend", 1, 0] } },
        // UX Feedback Aggregates (Phase 14)
        avgSentiment: { $avg: { $ifNull: ["$sentimentScore", 0.5] } }, // We'll need to store sentimentScore in the model too
        prefersFewerMessagesCount: {
          $sum: {
            $cond: [
              { $eq: ["$uxPreferences.prefersFewerMessages", true] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  if (!result.length) {
    return {
      trustScore: 50, // Default for new users
      totalFeedback: 0,
      isNewUser: true,
    };
  }

  const r = result[0];
  return {
    trustScore: Math.round(r.avgCalculatedScore || 50),
    avgRating: Math.round(r.avgRating * 10) / 10,
    avgSafetyRating: r.avgSafetyRating
      ? Math.round(r.avgSafetyRating * 10) / 10
      : null,
    totalFeedback: r.totalFeedback,
    incidentCount: r.incidentCount,
    recommendRate:
      r.totalFeedback > 0
        ? Math.round((r.recommendCount / r.totalFeedback) * 100)
        : null,
    // UX Aggregates
    avgSentiment: r.avgSentiment || 0.5,
    prefersFewerMessages:
      (r.prefersFewerMessagesCount || 0) > r.totalFeedback / 2, // Majority preference
    isNewUser: false,
  };
};

// Static method to get concerning users
tripFeedbackSchema.statics.getConcerningUsers = async function (
  threshold = 40,
) {
  return this.aggregate([
    {
      $group: {
        _id: "$toUserId",
        avgScore: { $avg: "$calculatedSafetyScore" },
        flagCount: { $sum: { $cond: ["$flaggedForReview", 1, 0] } },
        incidentCount: { $sum: { $cond: ["$hadSafetyIncident", 1, 0] } },
      },
    },
    {
      $match: {
        $or: [
          { avgScore: { $lt: threshold } },
          { incidentCount: { $gte: 2 } },
          { flagCount: { $gte: 3 } },
        ],
      },
    },
    { $sort: { avgScore: 1 } },
    { $limit: 50 },
  ]);
};

let TripFeedbackModel = null;

function getTripFeedbackModel() {
  if (!TripFeedbackModel) {
    const orderDB = getOrderDB();
    TripFeedbackModel = orderDB.model("TripFeedback", tripFeedbackSchema);
  }
  return TripFeedbackModel;
}

module.exports = { getTripFeedbackModel, tripFeedbackSchema };
