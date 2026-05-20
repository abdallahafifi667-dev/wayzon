const { getOrderModel } = require("../../models/order.models");

async function seedOrders(log, users) {
    const Order = getOrderModel();

    log("Clearing existing orders...");
    await Order.deleteMany({});

    const guideAhmed = users.find(u => u.username === "AhmedGuide");
    const guideSara = users.find(u => u.username === "SaraGuide");
    const touristJohn = users.find(u => u.username === "JohnTourist");
    const touristMaria = users.find(u => u.username === "MariaTraveler");

    const ordersToSeed = [
        {
            serviceType: "with_guide",
            destinationStatus: "defined",
            normal: touristJohn._id,
            guide: guideAhmed._id,
            tripMode: "guided",
            title: "Historic Cairo Full Day",
            description: "Visiting Citadel, Khan El Khalili, and Old Cairo.",
            TripDate: new Date(Date.now() + 86400000 * 2), // 2 days from now
            duration: 8,
            meetingPoint: { type: "Point", coordinates: [31.2357, 30.0444] },
            status: "in_progress",
            price: 120,
            destinationCountry: "Egypt",
            isSolo: false
        },
        {
            serviceType: "with_guide",
            destinationStatus: "defined",
            normal: touristMaria._id,
            guide: guideAhmed._id,
            tripMode: "guided",
            title: "Pyramids of Giza Private Tour",
            description: "Guided tour including Great Pyramid and Sphinx.",
            TripDate: new Date(Date.now() - 86400000 * 5), // 5 days ago
            duration: 4,
            meetingPoint: { type: "Point", coordinates: [31.1312, 29.9792] },
            status: "completed",
            price: 80,
            destinationCountry: "Egypt",
            isSolo: false
        },
        {
            serviceType: "with_guide",
            destinationStatus: "defined",
            normal: touristJohn._id,
            guide: guideSara._id,
            tripMode: "guided",
            title: "Saqqara & Memphis Exploration",
            description: "Explore the step pyramid and the ancient capital.",
            TripDate: new Date(Date.now() + 86400000 * 10), // 10 days from now
            duration: 6,
            meetingPoint: { type: "Point", coordinates: [31.2125, 29.8519] },
            status: "open",
            price: 100,
            destinationCountry: "Egypt",
            isSolo: false
        },
        {
            serviceType: "with_guide",
            destinationStatus: "defined",
            normal: touristMaria._id,
            tripMode: "guided",
            title: "Luxor East & West Bank",
            description: "Valley of the Kings, Karnak, and Luxor Temple.",
            TripDate: new Date(Date.now() + 86400000 * 20),
            duration: 12,
            meetingPoint: { type: "Point", coordinates: [32.6396, 25.6872] },
            status: "open",
            price: 250,
            destinationCountry: "Egypt",
            isSolo: false
        }
    ];

    const seededOrders = [];
    for (const orderData of ordersToSeed) {
        const order = await Order.create(orderData);
        seededOrders.push(order);
        log(`Seeded Order: ${order.title} (${order.status})`);
    }

    return seededOrders;
}

module.exports = seedOrders;
