const { getUserDB } = require("../config/conectet");
const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      required: true,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },

    comment: {
      type: String,
    },
  },
  { timestamps: true },
);

reviewSchema.index({ user: 1, product: 1 }, { unique: true }); // يمنع التكرار
module.exports = mongoose.model("Review", reviewSchema);

let UserModel;

const getUserReview = () => {
  if (UserModel) return UserModel;

  const db = getUserDB();
  UserModel = db.model("review", reviewSchema);
  return UserModel;
};

module.exports = { getUserReview };
