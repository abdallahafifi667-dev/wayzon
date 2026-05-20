const mongoose = require("mongoose");
const { getUserReview } = require("../models/Review.models");
const Review = getUserReview();
const { getOrderModel } = require("../models/order.models");
const Order = getOrderModel();

const updateProductRating = async (productId) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(productId))
      throw new Error("Invalid product ID");

    const productObjectId = new mongoose.Types.ObjectId(productId);

    const stats = await Review.aggregate([
      { $match: { product: productObjectId } },
      {
        $group: {
          _id: "$product",
          avgRating: { $avg: "$rating" },
          totalRatings: { $sum: 1 },
        },
      },
    ]);

    const avgRating = stats[0]?.avgRating
      ? Number(stats[0].avgRating.toFixed(2))
      : 0;
    const totalRatings = stats[0]?.totalRatings || 0;

    await Order.findByIdAndUpdate(
      productId,
      { avgRating, totalRatings },
      { new: true, runValidators: true },
    );
  } catch (err) {
    console.error("Error updating product rating:", err.message);
  }
};

module.exports = updateProductRating;
