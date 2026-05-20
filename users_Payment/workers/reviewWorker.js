const { subscribe } = require("../config/kafka");
const { getUserReview } = require("../models/Review.models");
const Review = getUserReview();
const updateProductRating = require("../middlewares/updateProductRating");

async function initReviewWorker() {
  await subscribe("review-add", async (data) => {
    const { productId, userId, comment, rating } = data;
    const review = new Review({
      product: productId,
      user: userId,
      comment,
      rating,
    });
    await review.save();
    await updateProductRating(productId);
  });

  await subscribe("review-update", async (data) => {
    const { reviewId, userId, comment } = data;
    const review = await Review.findOneAndUpdate(
      { _id: reviewId, user: userId },
      { comment },
      { new: true },
    );
    if (review) await updateProductRating(review.product);
  });

  await subscribe("review-delete", async (data) => {
    const { reviewId, userId } = data;
    const review = await Review.findOneAndDelete({
      _id: reviewId,
      user: userId,
    });
    if (review) await updateProductRating(review.product);
  });
}

initReviewWorker();
