const { getUserDB } = require("../config/conectet");
const mongoose = require("mongoose");
const { Schema } = mongoose;

const paymentTransactionSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        stripeSessionId: {
            type: String,
            unique: true,
            required: true,
        },
        amount: {
            type: Number,
            required: true,
        },
        currency: {
            type: String,
            default: "usd",
        },
        transactionType: {
            type: String,
            enum: ["credit_topup", "debt_clearance"],
            required: true,
        },
        status: {
            type: String,
            enum: ["completed", "failed", "pending"],
            default: "pending",
        },
        description: {
            type: String,
        },
        metadata: {
            type: Map,
            of: String,
        },
        paymentDate: {
            type: Date,
            default: Date.now,
        },
    },
    { timestamps: true }
);

let PaymentTransactionModel;

const getPaymentTransactionModel = () => {
    if (PaymentTransactionModel) return PaymentTransactionModel;

    const db = getUserDB();
    PaymentTransactionModel = db.model("PaymentTransaction", paymentTransactionSchema);
    return PaymentTransactionModel;
};

module.exports = { getPaymentTransactionModel };
