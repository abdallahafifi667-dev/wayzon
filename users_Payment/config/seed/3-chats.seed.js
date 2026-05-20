const { getChatModel } = require("../../models/Chat.models");

async function seedChats(log, users, orders) {
    const Chat = getChatModel();

    log("Clearing existing chats...");
    await Chat.deleteMany({});

    const guideAhmed = users.find(u => u.username === "AhmedGuide");
    const touristJohn = users.find(u => u.username === "JohnTourist");
    const orderInProgress = orders.find(o => o.status === "in_progress" && o.normal.toString() === touristJohn._id.toString());

    if (!orderInProgress) {
        log("No in-progress order found for John and Ahmed, skipping detailed chat seeding.");
        return [];
    }

    const messages = [
        {
            from: touristJohn._id,
            to: guideAhmed._id,
            message: "Hi Ahmed, what time should we meet at the Citadel?",
            orderId: orderInProgress._id,
            isRead: true
        },
        {
            from: guideAhmed._id,
            to: touristJohn._id,
            message: "Hello John! Let's meet at 9:00 AM at the main entrance.",
            orderId: orderInProgress._id,
            isRead: true
        },
        {
            from: touristJohn._id,
            to: guideAhmed._id,
            message: "Perfect. Will you be wearing a specific uniform or holding a sign?",
            orderId: orderInProgress._id,
            isRead: true
        },
        {
            from: guideAhmed._id,
            to: touristJohn._id,
            message: "I will be wearing a Wayzon hat and holding a small Wayzon flag. See you then!",
            orderId: orderInProgress._id,
            isRead: false
        }
    ];

    const seededChats = [];
    for (const msg of messages) {
        const chat = await Chat.create(msg);
        seededChats.push(chat);
    }

    log(`Seeded ${seededChats.length} chat messages for active order.`);
    return seededChats;
}

module.exports = seedChats;
