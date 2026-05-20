/**
 * Trip Monitoring Routes
 */

const express = require("express");
const router = express.Router();
const tripController = require("../controllers/trip.controllers");
const { verifyToken } = require("../middlewares/verifytoken");
const {
  validateLocationUpdate,
  validateSafetyResponse,
  validateRouteResponse,
} = require("../validators/TripValidator");

router.post(
  "/location",
  verifyToken,
  validateLocationUpdate,
  tripController.updateLocation,
);
router.post(
  "/safety-response",
  verifyToken,
  validateSafetyResponse,
  tripController.respondToSafetyCheck,
);
router.get("/:tripId/status", verifyToken, tripController.getTripStatus);
router.post(
  "/acknowledge-separation",
  verifyToken,
  tripController.acknowledgeSeparation,
);
router.post("/device-health", verifyToken, tripController.updateDeviceHealth);
router.post(
  "/route-response",
  verifyToken,
  validateRouteResponse,
  tripController.respondToRouteQuestion,
);
router.get("/:tripId/progress", verifyToken, tripController.getTripProgress);

router.post(
  "/check-meeting-point",
  verifyToken,
  tripController.checkMeetingPoint,
);
router.post(
  "/request-completion",
  verifyToken,
  tripController.requestCompletion,
);
router.post("/cancel", verifyToken, tripController.cancelTrip);
router.get(
  "/:tripId/payment-summary",
  verifyToken,
  tripController.getPaymentSummary,
);

// 🌟 Feedback Routes
router.post(
  "/:tripId/feedback",
  verifyToken,
  tripController.submitTripFeedback,
);

module.exports = router;
