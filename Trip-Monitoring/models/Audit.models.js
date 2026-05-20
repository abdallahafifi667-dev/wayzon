const { getAuditDB } = require("../config/conectet");
const mongoose = require("mongoose");
const { Schema } = mongoose;

const auditSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    ip: { type: String },
    action: { type: String, required: true },
    details: [
      {
        type: Array,
      },
    ],
  },
  { timestamps: true },
);

// إضافة TTL index
auditSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60, // 90 يوم
    name: "audit_ttl_index",
  },
);

let AuditModel;

const getAuditModel = () => {
  if (AuditModel) return AuditModel;

  const db = getAuditDB();
  AuditModel = db.model("Audit", auditSchema);
  return AuditModel;
};

module.exports = { getAuditModel };
