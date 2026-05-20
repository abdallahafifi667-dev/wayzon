const { getOrderDB } = require("../config/conectet");
const mongoose = require("mongoose");
const { Schema } = mongoose;

const chatSchema = new Schema(
    {
        from: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        to: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        message: {
            type: String,
            required: true,
        },
        messageType: {
            type: String,
            enum: ["text", "audio", "video", "system"],
            default: "text",
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
            required: true,
        },
        isRead: {
            type: Boolean,
            default: false,
        },
        readAt: {
            type: Date,
        },
        idempotencyKey: {
            type: String,
            unique: true,
            sparse: true,
            index: true,
        },
    },
    { timestamps: true },
);

// Index للبحث السريع عن الرسائل بين المستخدمين
chatSchema.index({ from: 1, to: 1, createdAt: -1 });
chatSchema.index({ orderId: 1 });

let ChatModel;
const getChatModel = () => {
    if (ChatModel) return ChatModel;
    const db = getOrderDB();
    ChatModel = db.model("Chat", chatSchema);
    return ChatModel;
};

module.exports = { getChatModel };
