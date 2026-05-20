/**
 * Layer 13: Temporal Risk Service
 * Handles time-sensitive threat anticipation and legal compliance.
 */

const { logger } = require("../../monitoring/metrics");
const {
  getDynamicSunTimes,
  fetchCountrySafetyRules,
} = require("../externalSafetyRulesService");
/**
 * Analyze temporal risk for a trip update
 * @param {Object} tripDetails - Full trip context
 * @param {Array} coordinates - Current [lng, lat]
 * @returns {Object} Temporal risk assessment
 */
async function analyzeTemporalRisk(tripDetails, coordinates) {
  const { country, countryName, startTime } = tripDetails;
  const now = new Date();
  const [lng, lat] = coordinates || [0, 0];

  const result = {
    riskScore: 0, // 0-100
    riskLevel: "low",
    factors: [],
    legalStatus: "compliant",
    context: {
      isNight: false,
      isInCurfew: false,
      sunTimes: null,
      rules: null,
    },
  };

  // 1. Dynamic Sun Times (Localized context)
  if (lat && lng) {
    const sunTimes = await getDynamicSunTimes(lat, lng);
    if (sunTimes) {
      result.context.sunTimes = sunTimes;
      // Night is after civil twilight end or before civil twilight begin
      const isNight =
        now > sunTimes.civil_twilight_end ||
        now < sunTimes.civil_twilight_begin;
      if (isNight) {
        result.context.isNight = true;
        result.riskScore += 25;
        result.factors.push("nighttime_operation");
        result.riskLevel = "elevated";
      }
    }
  }

  // 2. Legal Compliance (Curfews and restrictions)
  const rules = await fetchCountrySafetyRules(country, countryName || country);
  if (rules) {
    result.context.rules = rules;
    const currentHour = now.getHours();

    // Check if current time falls within legal curfew
    if (rules.hasCurfew) {
      const inCurfew = isTimeInWindow(currentHour, rules.start, rules.end);
      if (inCurfew) {
        result.context.isInCurfew = true;
        result.riskScore += 60; // Major risk
        result.factors.push("legal_curfew_violation");
        result.legalStatus = "non_compliant";
        result.riskLevel = "high";
      }
    }

    // Additional localized nighttime restrictions
    if (result.context.isNight && rules.additionalInfo) {
      const lowerInfo = rules.additionalInfo.toLowerCase();
      if (
        lowerInfo.includes("dangerous") ||
        lowerInfo.includes("restricted") ||
        lowerInfo.includes("avoid")
      ) {
        result.riskScore += 15;
        result.factors.push("local_night_warning");
      }
    }
  }

  // 3. Volatility Modeling (Placeholder for future time-series analysis)
  // We can check if this is the start of a risky window
  if (result.context.sunTimes) {
    const timeToSunset =
      (result.context.sunTimes.sunset.getTime() - now.getTime()) / (1000 * 60);
    if (timeToSunset > 0 && timeToSunset < 30) {
      result.factors.push("approaching_sunset_window");
      result.riskScore += 10;
    }
  }

  // Cap risk score
  result.riskScore = Math.min(100, result.riskScore);
  if (result.riskScore > 75) result.riskLevel = "critical";
  else if (result.riskScore > 50) result.riskLevel = "high";
  else if (result.riskScore > 20) result.riskLevel = "elevated";

  return result;
}

/**
 * Helper to check if time is within a window (handles wrapping around midnight)
 */
function isTimeInWindow(current, start, end) {
  if (start <= end) {
    return current >= start && current <= end;
  } else {
    // Window wraps (e.g., 22:00 to 06:00)
    return current >= start || current <= end;
  }
}

module.exports = {
  analyzeTemporalRisk,
};
