/**
 * Layer 14: Spatial Risk Engine
 * Environment-aware security that analyzes current, distant, and destination risk.
 */

const { logger } = require("../../monitoring/metrics");
const { checkReputation } = require("./locationReputationService");
const { getSearchEngineStatus } = require("./helper/searchEngineAggregator");

/**
 * Perform holistic spatial risk analysis
 * @param {Array} currentCoords - Current [lng, lat]
 * @param {Object} tripDetails - Trip context (includes destination/planned path)
 * @param {Object} userProfile - User behavioral profile
 * @returns {Object} Spatial risk assessment
 */
async function analyzeSpatialRisk(
  currentCoords,
  tripDetails,
  userProfile = {},
) {
  const {
    destinationCoordinates,
    destinationCountry,
    country,
    locations = [],
  } = tripDetails;

  // Determine target country profile for localized intelligence (Phase 17)
  const activeCountry = destinationCountry || country || "global";

  // 1. Current Location Risk (Environment understanding)
  const currentReputation = await checkReputation(currentCoords, {
    ...tripDetails,
    destinationCountry: activeCountry,
    userProfile,
  });

  // 2. Destination Risk (Target awareness)
  let destinationReputation = null;
  if (destinationCoordinates) {
    destinationReputation = await checkReputation(destinationCoordinates, {
      ...tripDetails,
      destinationCountry: destinationCountry || activeCountry,
      userProfile,
    });
  }

  const result = {
    riskScore: currentReputation.riskScore || 0,
    riskLevel: currentReputation.riskLevel || "low",
    currentRisk: {
      sentiment: currentReputation.sentiment,
      factors: currentReputation.dangerHits?.map((h) => h.word) || [],
      nearbyPlacesRisk: currentReputation.nearbyPlacesRisk || 0,
    },
    destinationRisk: destinationReputation
      ? {
          riskLevel: destinationReputation.riskLevel,
          sentiment: destinationReputation.sentiment,
        }
      : null,
    holisticContext: `Evaluating ${activeCountry} environment and trajectory safety.`,
    recommendations: [],
    safeAlternatives: currentReputation.safeAlternatives || [],
    shouldTriggerVideo: false, // Signal for orchestrator
  };

  // Holistic Logic: If moving from Low Risk to High Risk destination
  if (
    result.riskLevel === "low" &&
    destinationReputation?.riskLevel === "high"
  ) {
    result.factors = (result.factors || []).concat([
      "moving_towards_high_risk_zone",
    ]);
    result.recommendations.push(
      "Warning: You are approaching a region with known safety issues.",
    );
    result.riskScore += 25;
  }

  // Evaluation of surrounding areas (Phase 11)
  if (result.currentRisk.nearbyPlacesRisk > 50) {
    result.factors = (result.factors || []).concat(["risky_surroundings"]);
    result.riskScore += 15;
  }

  // Trigger Video Logic (Phase 12 Integration)
  // If spatial risk is elevated or we are in a high-risk zone, suggest video scan
  if (result.riskScore > 50 || currentReputation.shouldAlert) {
    result.shouldTriggerVideo = true;
  }

  // Finalize levels
  result.riskScore = Math.min(100, result.riskScore);
  if (result.riskScore > 75) result.riskLevel = "high";
  else if (result.riskScore > 40) result.riskLevel = "elevated";

  return result;
}

module.exports = {
  analyzeSpatialRisk,
};
