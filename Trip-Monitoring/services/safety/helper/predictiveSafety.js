/**
 * Predictive Safety Service - Layer 12
 * Predicts future risks based on movement vector (Vector Analysis)
 * and suggests proactive solutions.
 */

const locationReputationService = require("../locationReputationService");
const tripStateManager = require("../../tripStateManager");

const PREDICTION_TIME_HOOT = 5 * 60; // 5 minutes ahead
const VECTOR_CHECK_INTERVAL = 60 * 1000; // Check every minute to save resources

class PredictiveSafetyService {
  /**
   * Main entry point: Analyze future path
   */
  async analyzeFutureVector(
    tripId,
    currentCoords,
    speed,
    bearing,
    tripDetails,
  ) {
    // 1. Skip if stationary or extremely slow movement
    if (speed < 1) return { status: "stationary" };

    const state = await tripStateManager.getTripState(tripId);

    // Optimize: Don't check too often
    if (
      state.lastVectorCheck &&
      Date.now() - state.lastVectorCheck < VECTOR_CHECK_INTERVAL
    ) {
      return { status: "cached" };
    }

    // 2. Calculate Future Point (Vector Projection)
    const futureCoords = this.calculateDestination(
      currentCoords,
      bearing,
      speed * (PREDICTION_TIME_HOOT / 3.6),
    ); // distance in meters

    // 3. Scan Future Area
    // We use the existing reputation service but for the *future* coordinates
    const futureReputation =
      await locationReputationService.checkLocationSafety(
        futureCoords,
        tripDetails.country,
      );

    // 4. Update State
    await tripStateManager.updateTripState(tripId, {
      lastVectorCheck: Date.now(),
    });

    if (
      futureReputation.riskLevel === "high" ||
      futureReputation.riskLevel === "danger"
    ) {
      // 5. Find Solution (Proactive)
      const alternative = await this.findAlternativeRouteOrPlace(
        futureCoords,
        tripDetails,
      );

      return {
        status: "future_risk_detected",
        riskLevel: futureReputation.riskLevel,
        predictedLocation: futureCoords,
        riskDetails: futureReputation,
        recommendation: alternative,
      };
    }

    return { status: "safe_path" };
  }

  /**
   * Find a better alternative if the current/future place is bad
   */
  async findAlternativeRouteOrPlace(badCoords, tripDetails) {
    // Ask location service for better places nearby
    return await locationReputationService.findSafeAlternatives(
      badCoords,
      tripDetails.country,
    );
  }

  /**
   * Calculate destination point given distance and bearing
   * @param {Array} coords [lng, lat]
   * @param {number} bearing degrees
   * @param {number} distance meters
   */
  calculateDestination(coords, bearing, distance) {
    const R = 6371e3; // Earth radius in meters
    const lon1 = (coords[0] * Math.PI) / 180;
    const lat1 = (coords[1] * Math.PI) / 180;
    const brng = (bearing * Math.PI) / 180;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distance / R) +
        Math.cos(lat1) * Math.sin(distance / R) * Math.cos(brng),
    );

    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(distance / R) * Math.cos(lat1),
        Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2),
      );

    return [
      (((lon2 * 180) / Math.PI + 540) % 360) - 180, // Normalize longitude
      (lat2 * 180) / Math.PI,
    ];
  }
}

module.exports = new PredictiveSafetyService();
