const { logger } = require("../monitoring/metrics");
const { client: redis, connectRedis } = require("../config/redis");
const { aggregateSearch } = require("./safety/helper/searchEngineAggregator");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getSafetyEventModel } = require("../models/ml.model");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ✅ Aggressive caching to reduce API costs
const CACHE_TTL = 86400 * 7; // 7 days (was 1 day) - 86% cost reduction
const SUN_CACHE_TTL = 86400 * 7; // 1 week for sun times
const SEARCH_CACHE_TTL = 86400 * 30; // ✅ 30 days for search results
const RATE_LIMIT_TTL = 3600; // ✅ 1 hour rate limit per country

/**
 * Get dynamic sunset/sunrise for a location
 */
async function getDynamicSunTimes(lat, lng) {
  const cacheKey = `safety:sun:${lat.toFixed(2)}:${lng.toFixed(2)}`;

  try {
    if (!redis.isOpen) await connectRedis();
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug("Using cached sun times", { lat, lng });
      return JSON.parse(cached);
    }

    const response = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lng}&formatted=0`,
    );
    if (!response.ok) throw new Error("Sunrise-Sunset API failed");

    const data = await response.json();
    if (data.status !== "OK")
      throw new Error("Sunrise-Sunset API status NOT OK");

    const result = {
      sunrise: new Date(data.results.sunrise),
      sunset: new Date(data.results.sunset),
      civil_twilight_begin: new Date(data.results.civil_twilight_begin),
      civil_twilight_end: new Date(data.results.civil_twilight_end),
    };

    await redis.setEx(cacheKey, SUN_CACHE_TTL, JSON.stringify(result));
    return result;
  } catch (error) {
    logger.error("Failed to fetch sun times", {
      error: error.message,
      lat,
      lng,
    });
    return null;
  }
}

/**
 * Find active curfews or travel restrictions for a country via search + AI
 * ✅ With aggressive caching and rate limiting to reduce costs
 */
async function fetchCountrySafetyRules(countryCode, countryName) {
  const cacheKey = `safety:rules:${countryCode}`;

  if (!process.env.GEMINI_API_KEY) {
    logger.warn("GEMINI_API_KEY is not configured. Skipping external safety rules AI extraction.");
    return null; // Fallback to default rules
  }

  try {
    // ✅ Input validation
    if (!countryCode || typeof countryCode !== 'string') {
      throw new Error(`Invalid countryCode: ${countryCode}`);
    }

    if (!redis.isOpen) await connectRedis();

    // ✅ Check cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug("Using cached safety rules", { countryCode });
      return JSON.parse(cached);
    }

    // ✅ Rate limit check - prevent excessive API calls
    const rateLimitKey = `safety:ratelimit:${countryCode}`;
    const lastCall = await redis.get(rateLimitKey);
    if (lastCall) {
      const timeSinceLastCall = Date.now() - parseInt(lastCall);
      logger.warn("Rate limit hit for safety rules fetch", {
        countryCode,
        timeSinceLastCall,
        waitTime: RATE_LIMIT_TTL - Math.floor(timeSinceLastCall / 1000)
      });
      return null; // Use defaults - don't make expensive API call
    }

    const queries = [
      `active curfew hours in ${countryName} ${new Date().getFullYear()} official update`,
      `official road speed limits in ${countryName} highway and city`,
      `emergency laws and curfew times ${countryName}`,
    ];

    let combinedSnippets = "";
    for (const query of queries) {
      const searchResults = await aggregateSearch(query, {
        limit: 5,
        useCache: true,
        cacheTTL: SEARCH_CACHE_TTL, // ✅ Use the defined constant
      });
      combinedSnippets +=
        searchResults.allResults.map((r) => r.snippet).join("\n") + "\n";
    }

    // Use AI to extract structured rules
    const extractionPrompt = `
            Extract current safety rules, curfew hours, and road speed limits for ${countryName} from these search results:
            ${combinedSnippets}

            Rules to extract:
            1. Is there an active curfew? (boolean)
            2. Curfew start/end hours (0-23)
            3. Standard Highway Speed Limit for cars (km/h)
            4. Standard City Speed Limit for cars (km/h)
            5. Other nighttime restrictions (short text)
            6. Confidence level in this data (0-1)

            Output should be strictly JSON:
            {
                "hasCurfew": boolean,
                "start": number,
                "end": number,
                "maxSpeedHighway": number,
                "maxSpeedCity": number,
                "additionalInfo": string,
                "confidence": number,
                "timestamp": string
            }
        `;

    const result = await model.generateContent(extractionPrompt);
    const responseText = result.response.text();

    // Basic verification of AI result
    let rules = null;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        rules = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      logger.error("AI failed to return structured safety rules", {
        error: e.message,
        response: responseText,
      });
    }

    if (rules && rules.confidence > 0.4) {
      rules.lastUpdated = new Date().toISOString();

      // ✅ ML-controlled TTL (optional override)
      let ttl = CACHE_TTL;
      try {
        const mlPreferredTtl = await redis.get(
          `safety:ttl_override:${countryCode}`,
        );
        if (mlPreferredTtl) {
          ttl = parseInt(mlPreferredTtl);
          logger.info("Using ML-optimized TTL for safety rules", {
            countryCode,
            ttl,
          });
        }
      } catch (e) {
        // Ignore ML TTL errors
      }

      // ✅ Cache for 7 days
      await redis.setEx(cacheKey, ttl, JSON.stringify(rules));

      // ✅ Set rate limit (1 call per hour per country)
      await redis.setEx(rateLimitKey, RATE_LIMIT_TTL, Date.now().toString());

      // ✅ Log API cost (for monitoring)
      logger.info("Safety rules fetched from external APIs", {
        countryCode,
        confidence: rules.confidence,
        cacheTTL: ttl,
        estimatedCost: "$0.03" // 3 searches + 1 Gemini call
      });

      // Record for ML observation
      await recordExtractionEvent(countryCode, rules, combinedSnippets);

      return rules;
    }

    return null; // Fallback to defaults
  } catch (error) {
    logger.error("Failed to fetch country safety rules", {
      error: error.message,
      stack: error.stack,
      countryCode,
    });
    return null;
  }
}

/**
 * Phase 10: Record rule extraction as a SafetyEvent for ML training
 */
async function recordExtractionEvent(countryCode, rules, sourceData) {
  try {
    const SafetyEvent = getSafetyEventModel();
    await SafetyEvent.create({
      eventType: "rule_extraction",
      source: "external_safety_rules_service",
      tripContext: { country: countryCode },
      layerAnalysis: {
        reputation: {
          riskScore: rules.hasCurfew ? 80 : 20,
          searchData: {
            queries: ["curfew_search_aggregate"],
            topResults: [
              { title: "AI Extraction", snippet: sourceData.slice(0, 500) },
            ],
          },
        },
      },
      aiPrediction: {
        confidence: rules.confidence * 100,
        situation:
          rules.additionalInfo ||
          `Curfew: ${rules.hasCurfew ? `${rules.start}-${rules.end}` : "None"}`,
      },
      decision: {
        actionTaken: rules.hasCurfew
          ? "enforce_temporal_monitoring"
          : "standard_monitoring",
        skipToLayer: rules.confidence > 0.8 ? 12 : 10,
      },
    });
  } catch (err) {
    logger.error("Failed to record rule extraction event", {
      error: err.message,
    });
  }
}

/**
 * Background task to keep rules fresh
 */
async function refreshGlobalSafetyRules() {
  logger.info("Starting global safety rules refresh");

  try {
    const { getOrderModel } = require("../models/order.models");
    const Order = getOrderModel();

    // 1. Get countries with active trips
    const activeCountries = await Order.distinct("destinationCountry", {
      status: { $in: ["in_progress", "Gathering_time"] },
    });

    for (const countryCode of activeCountries) {
      if (!countryCode) continue;

      // Phase 10: Fetch and update (fetchCountrySafetyRules handles caching and ML TTL)
      await fetchCountrySafetyRules(countryCode, countryCode);
      logger.debug("Refreshed safety rules for active country", {
        countryCode,
      });
    }

    logger.info("Global safety rules refresh completed", {
      refreshedCount: activeCountries.length,
    });
  } catch (err) {
    logger.error("Global safety rules refresh failed", { error: err.message });
  }
}

module.exports = {
  getDynamicSunTimes,
  fetchCountrySafetyRules,
  refreshGlobalSafetyRules,
};
