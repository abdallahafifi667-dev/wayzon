const { getOrderDB } = require("../config/conectet");
const mongoose = require("mongoose");
const { Schema } = mongoose;

const tripNotificationHistorySchema = new Schema(
  {
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: [
        "speed_warning",
        "route_deviation",
        "safety_question",
        "reputation_warning",
        "predictive_warning",
        "urgent_safety",
        "meeting_confirmed",
        "low_battery",
        "general_alert",
      ],
    },
    riskLevel: {
      type: String, // 'low', 'medium', 'high', 'critical'
      default: "medium",
    },
    locationName: String,
    message: String,
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
    },
    sentAt: {
      type: Date,
      default: Date.now,
      expires: "7d", // Auto-delete after 7 days to keep collection small
    },
  },
  { timestamps: true },
);

// Compound index for efficient "Sticky Alert" checks: Find last alert of TYPE for TRIP
tripNotificationHistorySchema.index({ tripId: 1, type: 1, sentAt: -1 });

module.exports = getOrderDB().model(
  "TripNotificationHistory",
  tripNotificationHistorySchema,
);
