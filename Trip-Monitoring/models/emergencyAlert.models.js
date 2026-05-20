const { getOrderDB } = require("../config/conectet");
const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Emergency Alert Schema - Simplified Version
 * تخزين بلاغات الطوارئ فقط - الإدارة من سيرفر منفصل
 */
const EmergencyAlertSchema = new Schema(
  {
    // معرف الرحلة المرتبطة
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      required: true,
      index: true,
    },

    // نوع التنبيه
    alertType: {
      type: String,
      enum: [
        "NO_RESPONSE_TO_SAFETY_CHECK",
        "GUIDE_REMOVED_BY_TOURIST",
        "TOURIST_MISSING_GUIDE_PRESENT",
        "BOTH_MISSING",
        "GUIDE_MISSING_TOURIST_PRESENT",
        "ROUTE_DEVIATION",
        "MANUAL_REPORT",
      ],
      required: true,
    },

    // السبب التفصيلي
    reason: {
      type: String,
      required: true,
    },

    // مستوى الأولوية
    priority: {
      type: String,
      enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
      default: "HIGH",
    },

    // حالة البلاغ
    status: {
      type: String,
      enum: ["PENDING", "REVIEWED", "REPORTED", "DISMISSED", "RESOLVED"],
      default: "PENDING",
      index: true,
    },

    // من المختفي؟
    missingParty: {
      type: String,
      enum: ["TOURIST", "GUIDE", "BOTH", "NONE"],
      required: true,
    },

    // سجل كل الـ responses اللي النظام أرسلها
    systemResponses: [
      {
        type: {
          type: String,
          enum: [
            "REASSURANCE_CHECK",
            "ROUTE_DEVIATION",
            "SAFETY_CHECK",
            "NOTIFICATION",
          ],
        },
        attempt: Number,
        sentAt: Date,
        sentTo: {
          type: String,
          enum: ["TOURIST", "GUIDE", "BOTH"],
        },
        channel: {
          type: String,
          enum: ["FCM", "EMAIL", "SMS"],
        },
        response: {
          received: { type: Boolean, default: false },
          receivedAt: Date,
          content: String,
        },
      },
    ],

    // معلومات الإبلاغ (سيتم تحديثها من سيرفر الأدمن)
    reportDetails: {
      reportedAt: Date,
      reportedBy: String,
      method: {
        type: String,
        enum: ["PHONE", "WHATSAPP", "EMAIL", "IN_PERSON", "OTHER"],
      },
      notes: String,
      policeReportNumber: String,
    },

    // ملاحظات عامة
    notes: String,

    rawData: Schema.Types.Mixed,
  },
  {
    timestamps: true, // createdAt, updatedAt
  },
);

// Optimize queries for active alerts and history
EmergencyAlertSchema.index({ orderId: 1, status: 1 });
EmergencyAlertSchema.index({ status: 1, createdAt: -1 });

let EmergencyAlertModel;

const getEmergencyAlertModel = () => {
  if (EmergencyAlertModel) return EmergencyAlertModel;
  const db = getOrderDB();
  EmergencyAlertModel = db.model("EmergencyAlert", EmergencyAlertSchema);
  return EmergencyAlertModel;
};

module.exports = { getEmergencyAlertModel };
