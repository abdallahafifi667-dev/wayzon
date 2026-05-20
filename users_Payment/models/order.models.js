const { getOrderDB } = require("../config/conectet");
const mongoose = require("mongoose");
const { Schema } = mongoose;

const GeoPointSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
    },
  },
  { _id: false },
);

// Schema لكل موقع في الرحلة مع تتبع الزيارة
const LocationPointSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
    },
    visited: { type: Boolean, default: false },
    visitedAt: { type: Date },
  },
  { _id: true },
);

const MovementSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
    },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const OrderSchema = new Schema(
  {
    serviceType: {
      type: String,
      enum: ["with_guide", "solo_system"],
      required: true,
    },

    destinationStatus: {
      type: String,
      enum: ["defined", "undefined"],
      default: "defined",
      required: true,
    },

    normal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    guide: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      // Optional for "solo_system" mode
    },

    // tripMode is deprecated in favor of serviceType but kept for safety if needed by other services
    tripMode: {
      type: String,
      enum: ["guided", "solo_system"],
      default: "guided",
      required: true,
    },

    safetyConfig: {
      plan: { type: String, enum: ["free", "premium"], default: "free" },
    },

    // ✅ Two-Tier Safety System
    safetyMode: {
      type: String,
      enum: ["free", "paid"],
      default: "free",
      // Determined at trip start based on user credits
    },

    adSupported: {
      type: Boolean,
      default: false,
      // Set to true when trip starts in free mode (for ad-serving)
    },

    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 100,
    },

    description: {
      type: String,
      trim: true,
      minlength: 10,
      maxlength: 1500,
    },

    TripDate: {
      type: Date,
      required: true,
    },

    duration: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },

    // 🔥 مواقع الرحلة - بدون ترتيب إجباري
    locations: [LocationPointSchema],

    meetingPoint: GeoPointSchema,

    clientMovement: [MovementSchema],
    guideMovement: [MovementSchema],

    ClientStatus: {
      client1: { type: Boolean, default: false },
      client2: { type: Boolean, default: false },
    },

    status: {
      type: String,
      enum: [
        "open", // For defined trips waiting for specific guide or solo start
        "bidding", // For undefined trips waiting for guide offers
        "offer_selected", // Tourist picked a guide's offer
        "Submission_closed",
        "awaiting_guide_confirmation",
        "rejected_by_guide",
        "confirmed",
        "Gathering_time",
        "in_progress",
        "completed",
        "cancelled",
      ],
      default: "open",
    },

    // ✅ Initial price or budget set by the tourist (or accepted guide offer)
    price: {
      type: Number,
      required: true,
      min: 0,
    },

    // ✅ Platform fee for safety monitoring ($0 for free, $8 for premium)
    safetyFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Commission tracking (5% platform fee from guide's price)
    commission: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Cancellation fee (applied if tourist cancels near trip time)
    cancellationFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Track if cancellation fee is pending on tourist's next order
    pendingCancellationFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Cancellation details
    cancellation: {
      cancelledBy: {
        type: String,
        enum: ["tourist", "guide", "admin", "both", "system", "solo_system"],
      },
      cancelledAt: Date,
      reason: String,
      feeApplied: {
        type: Boolean,
        default: false,
      },
      requiresReview: {
        type: Boolean,
        default: false,
      },
    },

    // ✅ Trip completion tracking
    completion: {
      touristConfirmed: { type: Boolean, default: false },
      touristConfirmedAt: Date,
      guideConfirmed: { type: Boolean, default: false },
      guideConfirmedAt: Date,
      completedAt: Date,
      finalAmount: Number,
      touristDebtIncluded: { type: Number, default: 0 },
      commissionPaid: { type: Boolean, default: false },
      commissionAmount: Number,
    },

    // ✅ Meeting point tracking
    meetingTracking: {
      touristArrivedAt: Date,
      guideArrivedAt: Date,
      touristAtWrongLocation: { type: Boolean, default: false },
      guideAtWrongLocation: { type: Boolean, default: false },
      waitingTimerStarted: Date,
      noShowParty: String,
    },

    // ✅ Payment tracking
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "partial", "failed"],
      default: "pending",
    },

    paymentMethod: {
      type: String,
      enum: ["cash", "card", "wallet", "online"],
      default: "cash",
    },

    // ✅ Payout tracking for guide
    payoutStatus: {
      type: String,
      enum: ["pending", "done", "failed"],
      default: "pending",
    },

    Interested: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // ✅ Guides who were interested but had a time conflict with another accepted trip
    WithdrawnInterested: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // ✅ Offers from guides (for undefined destinations or competitive bidding on defined trips)
    offers: [
      {
        guide: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        proposedPrice: { type: Number, required: true },
        proposedItinerary: {
          type: [LocationPointSchema],
          required: false, // Only needed if trip destinationStatus is "undefined"
        },
        description: String,
        status: {
          type: String,
          enum: ["pending", "accepted", "rejected", "withdrawn_conflict"],
          default: "pending",
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // ✅ Destination country for the trip (validated against countries.json)
    destinationCountry: {
      type: String,
      required: true,
    },

    // ✅ Group / Companion Details
    isSolo: {
      type: Boolean,
      default: true,
    },
    companionsCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

// Performance Indexes
OrderSchema.index({ normal: 1, status: 1 }); // User trips by status
OrderSchema.index({ guide: 1, status: 1 }); // Guide trips
OrderSchema.index({ status: 1, createdAt: -1 }); // Recent trips
OrderSchema.index({ status: 1, TripDate: 1 }); // Upcoming trips

// Text Search
OrderSchema.index(
  { title: "text", description: "text" },
  {
    name: "trip_search_index",
    weights: { title: 10, description: 5 },
  },
);

// Geospatial Indexes
OrderSchema.index({ "locations.coordinates": "2dsphere" });
OrderSchema.index({ "meetingPoint.coordinates": "2dsphere" });

let OrderModel;

const getOrderModel = () => {
  if (OrderModel) return OrderModel;
  const db = getOrderDB();
  OrderModel = db.model("order", OrderSchema);
  return OrderModel;
};

module.exports = { getOrderModel };
