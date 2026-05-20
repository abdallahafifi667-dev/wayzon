var express = require("express");
var router = express.Router();
const {
  verifyToken,
  verifyTokenAndAuthorization,
} = require("../middlewares/verifytoken");
const {
  cancelOrder,
  completeTrip,
  createOrder,
  createOrderWithGuide,
  gatheringTime,
  getNearbyGuides,
  getOrders,
  reviewApplicants,
  selectGuide,
  selectOffer,
} = require("../controllers/order.controllers");
const { RemainingAccount } = require("../middlewares/RemainingAccount");
const {
  getOrdersForGuide,
  acceptOrder,
  confirmOrder,
  rejectOrder,
} = require("../controllers/order.guide.controllers");

router.post("/create", verifyToken, RemainingAccount, createOrder);
router.post(
  "/createWithGuide",
  verifyToken,
  RemainingAccount,
  createOrderWithGuide,
);
router.get("/getNearbyGuides", verifyToken, RemainingAccount, getNearbyGuides);
router.get("/getOrders", verifyToken, RemainingAccount, getOrders);
router.post("/cancelOrder", verifyToken, RemainingAccount, cancelOrder);
router.post("/selectGuide", verifyToken, RemainingAccount, selectGuide);
router.post("/selectOffer/:id", verifyToken, RemainingAccount, selectOffer);
router.post(
  "/reviewApplicants",
  verifyToken,
  RemainingAccount,
  reviewApplicants,
);

router.get(
  "/getOrdersForGuide",
  verifyToken,
  RemainingAccount,
  getOrdersForGuide,
);
router.post("/acceptOrder/:id", verifyToken, RemainingAccount, acceptOrder);
router.post("/confirmOrder/:id", verifyToken, RemainingAccount, confirmOrder);
router.post("/rejectOrder/:id", verifyToken, RemainingAccount, rejectOrder);
module.exports = router;
