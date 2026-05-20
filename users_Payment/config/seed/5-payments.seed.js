const { getPaymentTransactionModel } = require("../../models/PaymentTransaction.models");

async function seedPayments(log, users) {
    const Payment = getPaymentTransactionModel();

    log("Clearing existing transactions...");
    await Payment.deleteMany({});

    const touristJohn = users.find(u => u.username === "JohnTourist");
    const guideAhmed = users.find(u => u.username === "AhmedGuide");

    const transactions = [
        {
            userId: touristJohn._id,
            stripeSessionId: "mock_session_12345",
            amount: 500,
            currency: "usd",
            transactionType: "credit_topup",
            status: "completed",
            description: "Wallet top-up via Stripe"
        },
        {
            userId: guideAhmed._id,
            stripeSessionId: "mock_session_67890",
            amount: 120,
            currency: "usd",
            transactionType: "debt_clearance",
            status: "completed",
            description: "Payment for Historic Cairo Tour"
        }
    ];

    const seededPayments = [];
    for (const tx of transactions) {
        const payment = await Payment.create(tx);
        seededPayments.push(payment);
    }

    log(`Seeded ${seededPayments.length} payment transactions.`);
    return seededPayments;
}

module.exports = seedPayments;
