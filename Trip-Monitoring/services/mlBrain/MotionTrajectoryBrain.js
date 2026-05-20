/**
 * Motion Trajectory Brain - HTTP Client Bridge
 * Calls the Python ML Brain trajectory analysis endpoint
 */

const { mlBrainHttpClient: client } = require("./httpClient");
const { logger } = require("../../monitoring/metrics");

/**
 * Validate coordinate format
 * @throws {Error} if coordinates are invalid or missing
 */
function validateCoordinates(coordinates) {
  let longitude, latitude;

  if (Array.isArray(coordinates)) {
    [longitude, latitude] = coordinates;
  } else {
    longitude = coordinates.longitude || coordinates.lng;
    latitude = coordinates.latitude || coordinates.lat;
  }

  if (
    longitude === null ||
    longitude === undefined ||
    latitude === null ||
    latitude === undefined
  ) {
    throw new Error("Missing or invalid coordinates");
  }

  if (typeof longitude !== "number" || typeof latitude !== "number") {
    throw new Error("Coordinates must be numbers");
  }

  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new Error("Coordinates out of valid range");
  }

  return { longitude, latitude };
}

/**
 * Validate Python API response structure
 */
function validateAnalysisResponse(data) {
  if (!data.success || !data.analysis) {
    throw new Error("Invalid response structure from ML Brain");
  }

  const analysis = data.analysis;

  // Ensure required fields exist
  if (typeof analysis.tolerance_score !== "number") {
    throw new Error("Missing or invalid tolerance_score in response");
  }

  return analysis;
}

/**
 * Analyze trajectory to determine if deviation should be tolerated
 * Uses advanced motion prediction from Python ML Brain
 *
 * @param {string} tripId - Trip identifier
 * @param {Array|Object} coordinates - Current [lng, lat] or {longitude, latitude}
 * @param {number} speed - Current speed in km/h
 * @param {number} bearing - Current heading in degrees
 * @param {Object} tripDetails - Trip context with planned locations
 * @returns {Object} Analysis result with tolerance score and reasoning
 * @throws {Error} if coordinates are invalid or service fails critically
 */
async function analyzeTrajectory(
  tripId,
  coordinates,
  speed,
  bearing,
  tripDetails,
) {
  const startTime = Date.now();

  try {
    // Validate coordinates first
    const { longitude, latitude } = validateCoordinates(coordinates);

    const payload = {
      trip_id: tripId,
      coordinates: { longitude, latitude },
      speed: speed || 0,
      bearing: bearing || 0,
      locations: (tripDetails.locations || []).map((loc) => ({
        name: loc.name,
        coordinates: loc.coordinates,
      })),
    };

    const response = await client.post("/api/v1/trajectory/analyze", payload);
    const analysis = validateAnalysisResponse(response.data);

    const duration = Date.now() - startTime;
    logger.info("Trajectory analysis successful", {
      tripId,
      duration,
      toleranceScore: analysis.tolerance_score,
    });

    return {
      status: analysis.status || "analyzed",
      prediction: analysis.prediction || {},
      goalVetting: {
        isLogical: analysis.goal_vetting?.is_logical || false,
        reasons: analysis.goal_vetting?.reasons || [],
        confidence: analysis.goal_vetting?.confidence || 0,
      },
      rejoiningAnalysis: {
        rejoins: analysis.rejoining?.rejoins || false,
        target: analysis.rejoining?.target || "",
        confidence: analysis.rejoining?.confidence || 0,
      },
      toleranceScore: analysis.tolerance_score,
      shouldWait: analysis.should_wait || false,
      reasoning: analysis.reasoning || "",
    };
  } catch (err) {
    const duration = Date.now() - startTime;

    // Log as ERROR to ensure visibility in production
    logger.error("Trajectory analysis failed", {
      tripId,
      error: err.message,
      duration,
      stack: err.stack,
    });

    // Re-throw to let caller decide how to handle
    throw new Error(`ML Brain analysis failed: ${err.message}`);
  }
}

/**
 * Get default analysis when service is unavailable
 * @deprecated - Consider throwing error instead of returning defaults
 */
function getDefaultAnalysis() {
  return {
    status: "unavailable",
    prediction: {},
    goalVetting: { isLogical: false, reasons: [], confidence: 0 },
    rejoiningAnalysis: { rejoins: false, target: "", confidence: 0 },
    toleranceScore: 0,
    shouldWait: false,
    reasoning: "Trajectory analysis unavailable",
  };
}

/**
 * Project future position based on current movement vector
 * UTILITY ONLY - For quick client-side calculations
 * Do not rely on this for critical decisions; always use Python ML Brain for authoritative analysis
 *
 * @param {Array} coords - Current [lng, lat]
 * @param {number} bearing - Heading in degrees
 * @param {number} speed - Speed in km/h
 * @param {number} minutes - Time horizon
 * @returns {Array} Projected [lng, lat]
 */
function projectVector(coords, bearing, speed, minutes) {
  if (speed <= 0 || bearing == null) return coords;

  const R = 6371e3; // Earth radius in meters
  const [lon1, lat1] = coords;

  const lon1Rad = (lon1 * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const bearingRad = (bearing * Math.PI) / 180;

  // Distance in meters
  const distance = (speed / 3.6) * (minutes * 60);

  const lat2Rad = Math.asin(
    Math.sin(lat1Rad) * Math.cos(distance / R) +
      Math.cos(lat1Rad) * Math.sin(distance / R) * Math.cos(bearingRad),
  );

  const lon2Rad =
    lon1Rad +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(distance / R) * Math.cos(lat1Rad),
      Math.cos(distance / R) - Math.sin(lat1Rad) * Math.sin(lat2Rad),
    );

  const lon2 = (((lon2Rad * 180) / Math.PI + 540) % 360) - 180;
  const lat2 = (lat2Rad * 180) / Math.PI;

  return [lon2, lat2];
}

module.exports = {
  analyzeTrajectory,
  projectVector,
  getDefaultAnalysis,
  validateCoordinates,
  validateAnalysisResponse,
};
