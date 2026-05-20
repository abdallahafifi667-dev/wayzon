/**
 * Layer 8: Time Safety Analyzer - تحليل مخاطر الوقت
 * فحص حظر التجول والوقت الليلي ومدة الرحلة
 */
const { client: redis, connectRedis } = require("../../config/redis");
const { getSafetyEventModel } = require("../../models/ml.model");
const { logger } = require("../../monitoring/metrics");
const externalSafetyRulesService = require("../externalSafetyRulesService");

const REDIS_CURFEW_KEY = "safety:curfew_countries";

/**
 * Get curfew countries from Redis or fallback to default
 */
async function getCurfewCountries() {
  try {
    if (!redis.isOpen) await connectRedis();
    const cached = await redis.get(REDIS_CURFEW_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch (error) {
    logger.error("[TimeSafety] Redis error", { error: error.message });
    return {};
  }
}

/**
 * Update curfew data from ML learning
 */
async function updateCurfewFromML(countryCode, curfewData) {
  try {
    if (!redis.isOpen) await connectRedis();
    const countries = await getCurfewCountries();
    countries[countryCode] = curfewData;
    await redis.setEx(REDIS_CURFEW_KEY, 86400 * 30, JSON.stringify(countries));
    return true;
  } catch (error) {
    logger.error("[TimeSafety] Failed to update curfew", {
      error: error.message,
    });
    return false;
  }
}

/**
 * Remove curfew for a country (ML learned it's no longer needed)
 */
async function removeCurfew(countryCode) {
  try {
    if (!redis.isOpen) await connectRedis();
    const countries = await getCurfewCountries();
    delete countries[countryCode];
    await redis.setEx(REDIS_CURFEW_KEY, 86400 * 30, JSON.stringify(countries));
    return true;
  } catch (error) {
    logger.error("[TimeSafety] Failed to remove curfew", {
      error: error.message,
    });
    return false;
  }
}

/**
 * Learn curfew patterns from SafetyEvent data
 * Phase 10: Now acts as a secondary verification for dynamic rules
 */
async function learnCurfewFromData(countryCode) {
  try {
    const SafetyEvent = getSafetyEventModel();
    const events = await SafetyEvent.aggregate([
      {
        $match: {
          "tripContext.country": countryCode,
          "outcome.wasActualEmergency": true,
          createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: { $hour: "$timestamp" },
          count: { $sum: 1 },
          avgRiskScore: { $avg: "$riskScore" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    if (events.length < 5) return null;

    const dangerousHours = events
      .filter((e) => e.count > 3 && e.avgRiskScore > 0.7)
      .map((e) => e._id);

    if (dangerousHours.length > 0) {
      const start = Math.min(...dangerousHours);
      const end = Math.max(...dangerousHours);

      // If internal patterns persist that contradict dynamic rules, ML can flag a refresh
      const dynamicRules =
        await externalSafetyRulesService.fetchCountrySafetyRules(
          countryCode,
          countryCode,
        );
      if (!dynamicRules || !dynamicRules.hasCurfew) {
        logger.warn(
          "Internal data suggests curfew but external rules don't. Requesting ML review.",
          { countryCode },
        );
        // We don't overwrite here, we let the ML Brain decide via TTL override in the next step
      }

      return { start, end };
    }

    return null;
  } catch (error) {
    logger.error("[TimeSafety] Learning error:", error.message);
    return null;
  }
}

/**
 * Check if current time is within curfew hours for a country
 */
async function isInCurfew(countryCode, currentHour, countryName = null) {
  // 1. Check dynamic rules first
  const dynamicRules = await externalSafetyRulesService.fetchCountrySafetyRules(
    countryCode,
    countryName || countryCode,
  );

  if (dynamicRules && dynamicRules.hasCurfew) {
    const { start, end } = dynamicRules;
    if (start > end) return currentHour >= start || currentHour < end;
    return currentHour >= start && currentHour < end;
  }

  // 2. Fallback to learning/defaults if dynamic search fails
  const countries = await getCurfewCountries();
  const curfew = countries[countryCode];

  if (!curfew) return false;

  const { start, end } = curfew;

  // Handle overnight curfew (e.g., 22:00 - 05:00)
  if (start > end) {
    return currentHour >= start || currentHour < end;
  }
  return currentHour >= start && currentHour < end;
}

/**
 * Analyze time-related risks for a trip
 */
async function analyzeTimeRisk(tripDetails) {
  const { country, startTime, plannedEndTime } = tripDetails;
  const now = new Date();
  const currentHour = now.getHours();

  const result = {
    isNightTime: false,
    isInCurfew: false,
    riskLevel: "low",
    riskFactors: [],
    recommendations: [],
  };

  // Night time check (Dynamic solar data only)
  let isNight = false;

  // Try dynamic sun times if we have coordinates
  if (tripDetails.coordinates) {
    const [lng, lat] = tripDetails.coordinates;
    const sunTimes = await externalSafetyRulesService.getDynamicSunTimes(
      lat,
      lng,
    );
    if (sunTimes) {
      const now = new Date();
      // Night is after sunset or before sunrise (plus civil twilight buffer)
      isNight =
        now > sunTimes.civil_twilight_end ||
        now < sunTimes.civil_twilight_begin;
    }
  } else {
    // Fallback for missing coordinates (very rare) - check ML learned patterns for the country
    const patterns = await getCurfewCountries();
    const countryPattern = patterns[country];
    if (countryPattern && countryPattern.isNightHeuristic) {
      isNight =
        currentHour >= (countryPattern.nightStart || 22) ||
        currentHour < (countryPattern.nightEnd || 6);
    }
  }

  if (isNight) {
    result.isNightTime = true;
    result.riskFactors.push("night_hours");
    result.riskLevel = "elevated";
    result.recommendations.push(
      "Warning: Trip is occurring during night hours (after sunset)",
    );
  }

  // Curfew check (Dynamic)
  const inCurfew = await isInCurfew(
    country,
    currentHour,
    tripDetails.countryName,
  );
  if (inCurfew) {
    result.isInCurfew = true;
    result.riskFactors.push("curfew_violation");
    result.riskLevel = "high";
    result.recommendations.push(
      "Warning: Active curfew or night-time security restrictions in this country",
    );
  }

  // Late trip check
  if (plannedEndTime) {
    const plannedEnd = new Date(plannedEndTime);
    const plannedEndHour = plannedEnd.getHours();
    if (plannedEndHour >= 23 || plannedEndHour < 4) {
      result.riskFactors.push("late_ending_trip");
      if (result.riskLevel === "low") result.riskLevel = "elevated";
      result.recommendations.push("The trip is planned to end very late");
    }
  }

  return result;
}

/**
 * Check if trip duration exceeds expected time
 */
async function checkTripDuration(tripId, tripDetails) {
  const { startTime, expectedDuration, actualStartTime } = tripDetails;

  const start = actualStartTime
    ? new Date(actualStartTime)
    : new Date(startTime);
  const now = new Date();
  const elapsedMinutes = Math.floor((now - start) / (1000 * 60));

  const expected = expectedDuration;
  if (!expected)
    return { elapsedMinutes, isOvertime: false, shouldAlert: false };

  const maxAllowed = expected * 1.5; // 50% buffer

  const result = {
    elapsedMinutes,
    expectedDuration: expected,
    isOvertime: false,
    overtimePercentage: 0,
    shouldAlert: false,
  };

  if (elapsedMinutes > expected) {
    result.isOvertime = true;
    result.overtimePercentage = Math.floor(
      ((elapsedMinutes - expected) / expected) * 100,
    );

    if (elapsedMinutes > maxAllowed) {
      result.shouldAlert = true;
    }
  }

  return result;
}

/**
 * Get time-based risk score (0-1)
 */
/**
 * Get time-based risk score (0-1)
 */
function getTimeRiskScore(hour) {
  // Highest risk: 1-4 AM
  if (hour >= 1 && hour <= 4) return 0.9;
  // High risk: 0, 5 AM
  if (hour === 0 || hour === 5) return 0.7;
  // Elevated: 22-23, 6 AM
  if (hour >= 22 || hour === 6) return 0.5;
  // Normal business hours
  if (hour >= 9 && hour <= 18) return 0.1;
  // Default
  return 0.3;
}

/**
 * Weekly Scheduled Refresh Recommendation
 * Phase 10: Suggests content refresh based on age
 */
async function checkWeeklyRefreshNeeded(countryCode) {
  const lastCheck = await redis.get(`safety:last_full_refresh:${countryCode}`);
  if (!lastCheck || Date.now() - parseInt(lastCheck) > 86400 * 7 * 1000) {
    return true;
  }
  return false;
}

module.exports = {
  analyzeTimeRisk,
  checkTripDuration,
  getTimeRiskScore,
  isInCurfew,
  getCurfewCountries,
  updateCurfewFromML,
  removeCurfew,
  learnCurfewFromData,
};
