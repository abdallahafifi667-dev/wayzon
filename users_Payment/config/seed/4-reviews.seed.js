const { getUserReview } = require("../../models/Review.models");

async function seedReviews(log, users, orders) {
    const Review = getUserReview();

    log("Clearing existing reviews...");
    await Review.deleteMany({});

    const completedOrder = orders.find(o => o.status === "completed");
    if (!completedOrder) {
        log("No completed orders found, skipping reviews.");
        return [];
    }

    const touristMaria = users.find(u => u.username === "MariaTraveler");
    const touristJohn = users.find(u => u.username === "JohnTourist");
    const guideAhmed = users.find(u => u.username === "AhmedGuide");

    const reviews = [
        {
            user: touristMaria._id,
            product: completedOrder._id, // product is orderId in some logic, or guideId. Checking model...
            rating: 5,
            comment: "Ahmed was an amazing guide! He knows everything about the Pyramids and made the tour very special."
        },
        {
            user: touristJohn._id,
            product: completedOrder._id,
            rating: 4,
            comment: "Great experience overall. The transportation was comfortable and the timing was perfect."
        }
    ];

    const seededReviews = [];
    for (const rev of reviews) {
        const review = await Review.create(rev);
        seededReviews.push(review);
    }

    log(`Seeded ${seededReviews.length} reviews for completed orders.`);
    return seededReviews;
}

module.exports = seedReviews;
