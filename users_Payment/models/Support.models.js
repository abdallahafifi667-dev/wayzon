const { getUserDB } = require("../config/conectet");
const mongoose = require("mongoose");
const { Schema } = mongoose;

const supportSessionSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["pending", "in-progress", "resolved"],
      default: "pending",
    },
    lastMessage: {
      type: String,
      default: "",
    },
    lastMessageType: {
      type: String,
      enum: ["text", "image", "audio"],
      default: "text",
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
    unreadCountAdmin: {
      type: Number,
      default: 0,
      min: 0,
    },
    unreadCountUser: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

const supportMessageSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sender: {
      type: String,
      enum: ["user", "admin"],
      required: true,
    },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    message: {
      type: String,
      required: true,
    },
    messageType: {
      type: String,
      enum: ["text", "image", "audio"],
      default: "text",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

supportMessageSchema.index({ user: 1, createdAt: -1 });

let SupportSessionModel;
let SupportMessageModel;

const getSupportSessionModel = () => {
  if (SupportSessionModel) return SupportSessionModel;
  const db = getUserDB();
  SupportSessionModel = db.model("SupportSession", supportSessionSchema);
  return SupportSessionModel;
};

const getSupportMessageModel = () => {
  if (SupportMessageModel) return SupportMessageModel;
  const db = getUserDB();
  SupportMessageModel = db.model("SupportMessage", supportMessageSchema);
  return SupportMessageModel;
};

module.exports = {
  getSupportSessionModel,
  getSupportMessageModel,
};
