/**
 * Location Reputation Service - Layer 11
 * فحص سمعة المكان من الإنترنت والتعليقات
 *
 * يستخدم محركات البحث للعثور على:
 * - تقييمات المستخدمين
 * - تحذيرات من النصب أو السرقة
 * - تجارب سياحية سلبية
 * - معلومات أمان المنطقة
 */

const searchEngineAggregator = require("./helper/searchEngineAggregator");
const multiMapProvider = require("./mapVerifier");
const tripStateManager = require("../tripStateManager");
const NotificationService = require("../../controllers/Notification/notificationService");
const { getUserModel } = require("../../models/users.models");
const { getIo, userSocketMap } = require("../../socket");
const { logger } = require("../../monitoring/metrics");
const { client: redis, connectRedis } = require("../../config/redis");
const { getModels } = require("../../models/ml.model");
const videoRiskAnalyzer = require("./videoRiskAnalyzer");
const aiAnalyzer = require("./aiAnalyzer");

// Configuration
const REPUTATION_CACHE_PREFIX = "loc:reputation:";
const REPUTATION_CACHE_TTL = 86400; // 24 hours for Redis cache (short term)

// Data Freshness Configuration (in milliseconds)
const DATA_FRESHNESS = {
  PLACE_REPUTATION: 30 * 24 * 60 * 60 * 1000, // 🆕 Updated to 30 days (per user request)
  GENERAL_SAFETY: 365 * 24 * 60 * 60 * 1000, // 1 year for general area/roads safety
  HIGH_RISK_AREA: 3 * 30 * 24 * 60 * 60 * 1000, // 3 months for previously flagged areas
};

const CHECK_RADIUS = 200; // meters - how close to trigger check
const MIN_CHECK_INTERVAL = 3600000; // 1 hour - don't re-check same area

// Risk thresholds
const RISK_THRESHOLDS = {
  HIGH: 70,
  MEDIUM: 40,
  LOW: 0,
};

const RISK_LEVEL_MAP = {
  low: "safe",
  medium: "caution",
  high: "warning",
  danger: "dangerous",
  safe: "safe",
  caution: "caution",
  warning: "warning",
  dangerous: "dangerous",
  unknown: "unknown",
};

function normalizeRiskLevel(level) {
  return RISK_LEVEL_MAP[level?.toLowerCase()] || "unknown";
}

/**
 * Check if cached reputation data needs refresh based on age and type
 * @param {Object} cachedData - Cached reputation data
 * @returns {Object} { needsRefresh, reason }
 */
function checkDataFreshness(cachedData) {
  if (!cachedData || !cachedData.checkedAt) {
    return { needsRefresh: true, reason: "no_data" };
  }

  const checkedAt = new Date(cachedData.checkedAt).getTime();
  const dataAge = Date.now() - checkedAt;
  const dataAgeDays = Math.floor(dataAge / (24 * 60 * 60 * 1000));

  // High risk areas need more frequent refresh
  if (cachedData.riskLevel === "high" || cachedData.shouldAlert) {
    if (dataAge > DATA_FRESHNESS.HIGH_RISK_AREA) {
      return {
        needsRefresh: true,
        reason: "high_risk_stale",
        ageDays: dataAgeDays,
      };
    }
  }

  // Place-specific reputation (businesses, tourist spots)
  if (
    cachedData.locationName &&
    cachedData.locationName !== "Unknown Location"
  ) {
    if (dataAge > DATA_FRESHNESS.PLACE_REPUTATION) {
      return {
        needsRefresh: true,
        reason: "place_reputation_stale",
        ageDays: dataAgeDays,
      };
    }
  }

  // General area safety
  if (dataAge > DATA_FRESHNESS.GENERAL_SAFETY) {
    return {
      needsRefresh: true,
      reason: "general_data_stale",
      ageDays: dataAgeDays,
    };
  }

  return { needsRefresh: false, ageDays: dataAgeDays };
}

/**
 * Check location reputation from multiple sources
 * @param {Array} coordinates - [lng, lat]
 * @param {Object} tripDetails - Trip context
 * @returns {Object} Reputation analysis
 */
async function checkReputation(coordinates, tripDetails = {}) {
  // ✅ Validate coordinates to prevent data pollution
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
    logger.error("Invalid coordinates format for reputation check", {
      coordinates,
      tripId: tripDetails.tripId,
    });
    return {
      coordinates: [0, 0],
      locationName: "Invalid Location",
      riskScore: 50,
      riskLevel: "unknown",
      shouldAlert: false,
      error: "Invalid coordinates format",
    };
  }

  const [lng, lat] = coordinates;

  // ✅ Reject null island [0,0]
  if (lng === 0 && lat === 0) {
    logger.error("Rejected [0,0] coordinates in reputation check", {
      tripId: tripDetails.tripId,
    });
    return {
      coordinates: [0, 0],
      locationName: "Invalid Location (Null Island)",
      riskScore: 50,
      riskLevel: "unknown",
      shouldAlert: false,
      error: "Invalid coordinates: [0,0] not allowed",
    };
  }

  // ✅ Validate coordinate ranges
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    logger.error("Coordinates out of valid range for reputation check", {
      coordinates,
      tripId: tripDetails.tripId,
    });
    return {
      coordinates,
      locationName: "Invalid Location (Out of Range)",
      riskScore: 50,
      riskLevel: "unknown",
      shouldAlert: false,
      error: "Coordinates out of valid range",
    };
  }

  const cacheKey = `${REPUTATION_CACHE_PREFIX}${lat.toFixed(3)},${lng.toFixed(3)}`;

  // Check cache first with freshness validation
  try {
    if (!redis.isOpen) await connectRedis();
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      const freshness = checkDataFreshness(parsed);

      // If data is still fresh, return cached
      if (!freshness.needsRefresh) {
        parsed.fromCache = true;
        parsed.dataAgeDays = freshness.ageDays;
        return parsed;
      }

      // Data is stale but still return for immediate use, refresh in background
      logger.info("Reputation data stale, refreshing in background", {
        location: parsed.locationName,
        reason: freshness.reason,
        ageDays: freshness.ageDays,
      });

      // Return stale data immediately but mark for refresh
      parsed.fromCache = true;
      parsed.needsRefresh = true;
      parsed.dataAgeDays = freshness.ageDays;
      parsed.staleReason = freshness.reason;

      // Trigger async refresh (don't await)
      refreshReputationAsync(coordinates, tripDetails, cacheKey);

      return parsed;
    }
  } catch (err) {
    logger.debug("Reputation cache miss", { error: err.message });
  }

  // Get location name from map providers
  let locationInfo;
  try {
    locationInfo = await multiMapProvider.reverseGeocode(coordinates);
  } catch (err) {
    locationInfo = { address: `${lat},${lng}`, provider: "none" };
  }

  // Extract location name from address
  const addressParts = (locationInfo.address || "").split(",");
  const locationName = addressParts[0]?.trim() || "Unknown Location";
  const area = addressParts[1]?.trim() || "";
  const country =
    tripDetails.destinationCountry ||
    addressParts[addressParts.length - 1]?.trim();

  // Search for safety information
  const searchQueries = [
    `"${locationName}" ${area} safety tourist`,
    `"${locationName}" scam warning`,
    `${area} ${country} crime tourist`,
  ];

  // Phase 28: Multi-Level Cache (Level 2: MongoDB)
  try {
    const { LocationReputation } = getModels();
    const dbMatched = await LocationReputation.findOne({
      $or: [
        {
          coordinates: {
            $near: {
              $geometry: { type: "Point", coordinates: [lng, lat] },
              $maxDistance: 100,
            },
          },
        },
        { locationName: { $regex: new RegExp(`^${locationName}$`, "i") } },
      ],
    });

    if (dbMatched) {
      const freshness = checkDataFreshness(dbMatched);
      if (!freshness.needsRefresh) {
        const result = dbMatched.toObject();
        result.fromCache = true;
        result.fromDB = true;
        return result;
      }
    }
  } catch (err) {
    logger.debug("MongoDB reputation check failed", { error: err.message });
  }

  const allResults = [];
  const countryCode = (country || "").length === 2 ? String(country).toUpperCase() : "global";

  for (const query of searchQueries) {
    try {
      const searchResult = await searchEngineAggregator.aggregateSearch(query, {
        engines: searchEngineAggregator.getSearchEnginesForCountry(countryCode),
        limit: 5,
        useCache: true,
        userId: tripDetails.normal,
      });
      allResults.push(...searchResult.allResults);
    } catch (err) {
      logger.debug("Reputation search failed", { query, error: err.message });
    }
  }

  // Analyze sentiment
  const sentiment = searchEngineAggregator.analyzeSentiment(allResults);

  // Phase 24: Enhanced Google Reviews Analysis
  let reviewData = { reviews: [], aiVerdict: null };
  if (locationInfo.placeId) {
    try {
      const details = await multiMapProvider.fetchPlaceDetails(
        locationInfo.placeId,
      );
      if (details && details.reviews.length > 0) {
        // Local Analysis
        const localAnalysis = analyzeReviewsLocally(details.reviews);

        // AI Analysis if suspicious or enough data
        let aiVerdict = null;
        if (localAnalysis.isSuspicious || details.reviews.length >= 3) {
          aiVerdict = await analyzeReviewsWithAI(details.reviews, locationName);
        }

        reviewData = {
          reviews: details.reviews,
          localAnalysis,
          aiVerdict,
        };

        // Adjust risk score if AI or Local finds danger
        if (aiVerdict?.riskLevel === "high" || localAnalysis.isSuspicious) {
          sentiment.riskLevel = "high";
          sentiment.dangerScore += 20;
        }
      }
    } catch (err) {
      logger.debug("Failed to fetch/analyze Google reviews", {
        error: err.message,
      });
    }
  }

  // Build reputation result
  const reputation = {
    coordinates,
    locationName,
    area,
    country,
    address: locationInfo.address,
    resultsAnalyzed: allResults.length,
    riskScore: calculateRiskScore(sentiment, allResults.length),
    riskLevel: normalizeRiskLevel(sentiment.riskLevel),
    sentiment: sentiment.sentiment,
    dangerHits: sentiment.dangerHits,
    shouldAlert: false,
    alertReason: null,
    reviewAnalysis: reviewData, // Added for deep insight
    sources: [...new Set(allResults.map((r) => r.source))].slice(0, 5),
    searchData: {
      queries: searchQueries,
      dangerScore: sentiment.dangerScore,
      safeScore: sentiment.safeScore,
      results: allResults.slice(0, 10).map((r) => ({
        title: r.title,
        snippet: r.snippet,
        url: r.url,
        source: r.source,
      })),
    },
    checkedAt: new Date().toISOString(),
  };

  // 🆕 Automatically find safe alternatives if location is risky
  if (
    reputation.riskLevel === "high" ||
    reputation.riskLevel === "danger" ||
    reputation.riskLevel === "dangerous"
  ) {
    try {
      reputation.safeAlternatives = await findSafeAlternatives(
        coordinates,
        reputation.country,
        { userProfile: tripDetails.userProfile },
      );
    } catch (err) {
      logger.debug(
        "Failed to fetch safe alternatives during reputation check",
        { error: err.message },
      );
    }
  }

  // 🆕 Step 3 Escalation: Lazy Video Scan (Profit Protection)
  // Only trigger video scan if:
  // 1. Text results are insufficient (No local data/history)
  // 2. Initial text signals "high" risk
  // 3. Area is flagged as suspicious by local indicators
  if (
    allResults.length < 5 ||
    sentiment.riskLevel === "high" ||
    sentiment.dangerHits.length >= 2
  ) {
    logger.info("Escalating to Lazy Video Scan for better accuracy/safety", {
      locationName,
      results: allResults.length,
    });

    const videoRisks = await videoRiskAnalyzer.analyzeAreaRisks(coordinates, {
      forceCheck: true,
      locationName,
      country,
      tripId: tripDetails.tripId,
    });

    if (
      videoRisks.riskLevel === "danger" ||
      videoRisks.riskLevel === "warning"
    ) {
      reputation.riskScore = Math.max(
        reputation.riskScore,
        videoRisks.riskLevel === "danger" ? 90 : 60,
      );
      reputation.riskLevel = normalizeRiskLevel(videoRisks.riskLevel);
      reputation.shouldAlert = true;
      reputation.alertReason = `Video Intelligence: ${videoRisks.description}`;
      reputation.videoEvidence = videoRisks.evidence;
    }
  }

  // Determine if further deep scan is needed (historical logic kept as backup)
  if (
    !reputation.shouldAlert &&
    (sentiment.riskLevel === "high" || sentiment.dangerHits.length >= 2)
  ) {
    logger.info("Performing deep reputation scan for suspicious location", {
      locationName,
    });

    // Phase 23: Combine online search with real-time map place analysis
    const [deepSearch, mapAnalysis] = await Promise.all([
      searchEngineAggregator.searchLocationSafety(locationName, country),
      multiMapProvider.analyzePlaces(coordinates),
    ]);

    // Merge deep scan results
    reputation.riskScore = Math.max(
      reputation.riskScore,
      deepSearch.dangerScore * 10,
      mapAnalysis.score || 0,
    );
    reputation.riskLevel = deepSearch.riskLevel;
    reputation.shouldAlert =
      deepSearch.shouldAlert || mapAnalysis.riskLevel === "high";
    reputation.alertReason =
      deepSearch.shouldAlert || mapAnalysis.riskLevel === "high"
        ? "Confirmed safety concerns in deep scan (Search + Maps)"
        : reputation.alertReason;
    reputation.sentiment = deepSearch.sentiment;
    reputation.mapContext = mapAnalysis; // Store map context for AI

    if (deepSearch.dangerHits.length > 0) {
      reputation.dangerHits = [
        ...new Set([...reputation.dangerHits, ...deepSearch.dangerHits]),
      ];
    }
  }

  // Cache result
  try {
    await redis.setEx(
      cacheKey,
      REPUTATION_CACHE_TTL,
      JSON.stringify(reputation),
    );

    // Phase 25: Persistent History for AI Training
    await saveReputationToHistory(reputation);
  } catch (e) {
    logger.debug("Failed to cache/save reputation history", {
      error: e.message,
    });
  }

  logger.info("Location reputation checked", {
    location: locationName,
    riskScore: reputation.riskScore,
    riskLevel: reputation.riskLevel,
    shouldAlert: reputation.shouldAlert,
  });

  return reputation;
}

/**
 * Refresh reputation data asynchronously (non-blocking)
 * Called when cached data is stale but still needs immediate return
 */
async function refreshReputationAsync(coordinates, tripDetails, cacheKey) {
  try {
    const [lng, lat] = coordinates;

    // Get location name
    let locationInfo;
    try {
      locationInfo = await multiMapProvider.reverseGeocode(coordinates);
    } catch (err) {
      locationInfo = { address: `${lat},${lng}`, provider: "none" };
    }

    const addressParts = (locationInfo.address || "").split(",");
    const locationName = addressParts[0]?.trim() || "Unknown Location";
    const area = addressParts[1]?.trim() || "";
    const country =
      tripDetails.destinationCountry ||
      addressParts[addressParts.length - 1]?.trim();

    // Fresh search
    const searchQueries = [
      `"${locationName}" ${area} safety tourist`,
      `"${locationName}" scam warning`,
      `${area} ${country} crime tourist`,
    ];

    const allResults = [];
    for (const query of searchQueries) {
      try {
        const searchResult = await searchEngineAggregator.aggregateSearch(
          query,
          {
            engines: ["duckduckgo", "google", "bing"],
            limit: 5,
            useCache: false, // Force fresh search
            userId: tripDetails.normal,
          },
        );
        allResults.push(...searchResult.allResults);
      } catch (err) {
        // Continue with other queries
      }
    }

    const sentiment = searchEngineAggregator.analyzeSentiment(allResults);

    const freshReputation = {
      coordinates,
      locationName,
      area,
      country,
      address: locationInfo.address,
      resultsAnalyzed: allResults.length,
      riskScore: calculateRiskScore(sentiment, allResults.length),
      riskLevel: sentiment.riskLevel,
      sentiment: sentiment.sentiment,
      dangerHits: sentiment.dangerHits,
      shouldAlert:
        sentiment.riskLevel === "high" || sentiment.dangerHits.length >= 3,
      sources: [...new Set(allResults.map((r) => r.source))].slice(0, 5),
      searchData: {
        queries: searchQueries,
        dangerScore: sentiment.dangerScore,
        safeScore: sentiment.safeScore,
        results: allResults.slice(0, 10).map((r) => ({
          title: r.title,
          snippet: r.snippet,
          url: r.url,
          source: r.source,
        })),
      },
      checkedAt: new Date().toISOString(),
    };

    // Update cache
    if (!redis.isOpen) await connectRedis();
    await redis.setEx(
      cacheKey,
      REPUTATION_CACHE_TTL,
      JSON.stringify(freshReputation),
    );

    logger.info("Reputation data refreshed in background", {
      location: locationName,
      riskScore: freshReputation.riskScore,
    });
  } catch (err) {
    logger.error("Background reputation refresh failed", {
      error: err.message,
    });
  }
}

/**
 * Calculate overall risk score (0-100)
 */
function calculateRiskScore(sentiment, resultCount) {
  if (resultCount === 0) return 30; // Unknown = moderate risk

  let score = 0;

  // Danger score contributes more
  score += sentiment.dangerScore * 5;

  // Safe score reduces risk
  score -= sentiment.safeScore * 2;

  // Normalize
  score = Math.max(0, Math.min(100, score));

  // If no results about danger, assume safer
  if (sentiment.dangerHits.length === 0) {
    score = Math.min(score, 30);
  }

  return Math.round(score);
}

/**
 * Process location update and check reputation if needed
 * @param {string} tripId - Trip ID
 * @param {Array} coordinates - [lng, lat]
 * @param {Object} tripDetails - Trip context
 * @param {Object} userProfile - User behavioral profile
 * @returns {Object} Reputation check result or null if skipped
 */
async function processLocationForReputation(
  tripId,
  coordinates,
  tripDetails,
  userProfile = {},
) {
  const state = (await tripStateManager.getTripState(tripId)) || {};

  // Check if we recently checked nearby
  if (state.lastReputationCheck) {
    const timeSinceCheck = Date.now() - state.lastReputationCheck.timestamp;
    if (timeSinceCheck < MIN_CHECK_INTERVAL) {
      // Check if moved significantly
      const distance = tripStateManager.calculateDistance(
        state.lastReputationCheck.coordinates,
        coordinates,
      );
      if (distance < CHECK_RADIUS * 3) {
        return { skipped: true, reason: "recently_checked" };
      }
    }
  }

  // Check reputation
  const reputation = await checkReputation(coordinates, tripDetails);

  // Update state
  state.lastReputationCheck = {
    coordinates,
    timestamp: Date.now(),
    result: reputation.riskLevel,
  };
  await tripStateManager.setTripState(tripId, state);

  // Alert if high risk
  if (reputation.shouldAlert) {
    await sendReputationAlert(tripId, tripDetails, reputation, userProfile);
  }

  return reputation;
}

/**
 * Send alert to both parties about dangerous location
 */
async function sendReputationAlert(
  tripId,
  tripDetails,
  reputation,
  userProfile = {},
) {
  const io = getIo();

  // 🆕 Find safe alternatives for risky locations
  let safeAlternatives = [];
  if (
    reputation.riskLevel === "high" ||
    reputation.riskLevel === "danger" ||
    reputation.riskLevel === "dangerous"
  ) {
    try {
      safeAlternatives = await findSafeAlternatives(
        reputation.coordinates || [0, 0],
        tripDetails.destinationCountry,
        { userProfile },
      );
    } catch (err) {
      logger.debug("Failed to fetch safe alternatives", { error: err.message });
    }
  }

  const alertMessage = {
    type: "location_reputation_warning",
    tripId,
    location: reputation.locationName,
    riskLevel: reputation.riskLevel,
    riskScore: reputation.riskScore,
    reason: reputation.alertReason,
    warnings: reputation.dangerHits.map((h) => h.word).slice(0, 3),
    recommendation:
      "Please be cautious in this area. Online warnings have been found.",
    // 🆕 Include safe alternatives in the alert
    safeAlternatives: safeAlternatives.map((alt) => ({
      name: alt.name,
      distance: alt.distanceText,
      rating: alt.rating,
      address: alt.address,
    })),
    hasAlternatives: safeAlternatives.length > 0,
  };

  // Helper: Determine if we should notify based on user preference (Adaptive Intensity)
  const shouldNotify = (role) => {
    const rules = tripDetails.notificationRules || {};
    const intensity = rules[role] || "normal";
    const level = reputation.riskLevel;

    // "very_low" (e.g. annoyed guide) -> Only Critical Danger
    if (intensity === "very_low")
      return level === "dangerous" || level === "danger";
    // "low" -> No Caution items, only High/Danger
    if (intensity === "low") return level !== "caution" && level !== "safe";

    return true; // Normal/High receive all alerts
  };

  // Notify tourist (Check preference)
  if (shouldNotify("tourist")) {
    const touristSocketId = userSocketMap?.get(tripDetails.normal?.toString());
    if (touristSocketId) {
      io.to(touristSocketId).emit("reputation_warning", alertMessage);
    }
  }

  // Notify guide (Check preference)
  if (shouldNotify("guide") && tripDetails.guide) {
    const guideSocketId = userSocketMap?.get(tripDetails.guide?.toString());
    if (guideSocketId) {
      io.to(guideSocketId).emit("reputation_warning", alertMessage);
    }
  }

  // Send FCM notifications for high risk (Filtered)
  if (
    reputation.riskLevel === "high" ||
    reputation.riskLevel === "danger" ||
    reputation.riskLevel === "dangerous"
  ) {
    let touristFCM = tripDetails.touristFCM;
    let guideFCM = tripDetails.guideFCM;

    // Fetch tokens if missing
    if (!touristFCM || (!guideFCM && tripDetails.guide)) {
      const User = getUserModel();
      const [tourist, guide] = await Promise.all([
        User.findById(tripDetails.normal).select("fcmTokens").lean(),
        tripDetails.guide
          ? User.findById(tripDetails.guide).select("fcmTokens").lean()
          : null,
      ]);
      touristFCM = touristFCM || tourist?.fcmTokens;
      guideFCM = guideFCM || guide?.fcmTokens;
    }

    // 🆕 Include alternatives in FCM message
    let fcmMessage = `⚠️ Warning: ${reputation.locationName} - Negative reports found for this area`;
    if (safeAlternatives.length > 0) {
      fcmMessage +=
        `\n\n✅ Nearby safe places:\n` +
        safeAlternatives
          .slice(0, 2)
          .map((a) => `• ${a.name} (${a.distanceText})`)
          .join("\n");
    }

    const notifications = [];

    if (touristFCM?.length && shouldNotify("tourist")) {
      notifications.push(
        NotificationService.sendToMultipleDevices(
          touristFCM,
          "⚠️ Location Safety Warning",
          fcmMessage,
          { tripId, type: "reputation_warning", ...alertMessage },
        ),
      );
    }

    // Only send to guide if they exist AND preference allows
    if (guideFCM?.length && tripDetails.guide && shouldNotify("guide")) {
      notifications.push(
        NotificationService.sendToMultipleDevices(
          guideFCM,
          "⚠️ Location Safety Warning",
          fcmMessage,
          { tripId, type: "reputation_warning", ...alertMessage },
        ),
      );
    }

    await Promise.allSettled(notifications);
  }

  logger.warn("Reputation alert processed", {
    tripId,
    location: reputation.locationName,
    riskScore: reputation.riskScore,
    sentToTourist: shouldNotify("tourist"),
    sentToGuide: shouldNotify("guide"),
    alternativesFound: safeAlternatives.length,
  });
}

/**
 * Get reputation history for a trip
 */
async function getReputationHistory(tripId) {
  const state = await tripStateManager.getTripState(tripId);
  return state?.reputationHistory || [];
}

/**
 * Manual reputation check (for admin/testing)
 */
async function checkLocationManually(coordinates, country) {
  return await checkReputation(coordinates, { destinationCountry: country });
}

/**
 * Local rapid sentiment scan for Google reviews
 */
function analyzeReviewsLocally(reviews) {
  const dangerKeywords = DANGER_KEYWORDS.en.concat(DANGER_KEYWORDS.ar);
  let isSuspicious = false;
  const flaggedKeywords = [];

  reviews.forEach((review) => {
    const text = (review.text || "").toLowerCase();
    dangerKeywords.forEach((word) => {
      if (text.includes(word.toLowerCase())) {
        isSuspicious = true;
        if (!flaggedKeywords.includes(word)) flaggedKeywords.push(word);
      }
    });
  });

  return { isSuspicious, flaggedKeywords };
}

/**
 * Use AI to analyze review context deeply
 */
async function analyzeReviewsWithAI(reviews, locationName) {
  // Phase 26: Call AI Analyzer for review context
  const prompt = `Analyze these Google Maps reviews for "${locationName}". 
    Look for specific mentions of scams, theft, harassment, or safety risks.
    Ignore general complaints about food or service.
    Reviews: ${JSON.stringify(reviews.slice(0, 10))}`;

  try {
    const verdict = await aiAnalyzer.analyzeText(prompt);
    return {
      riskLevel: verdict.riskLevel || "low",
      summary:
        verdict.summary || "No significant safety risks identified in reviews.",
      detectedRisks: verdict.detectedRisks || [],
    };
  } catch (err) {
    return { riskLevel: "low", summary: "AI analysis unavailable" };
  }
}

/**
 * Persist reputation data for future learning
 */
async function saveReputationToHistory(reputation) {
  try {
    const { LocationReputation } = getModels();
    await LocationReputation.findOneAndUpdate(
      { locationName: reputation.locationName },
      {
        ...reputation,
        coordinates: {
          type: "Point",
          coordinates: reputation.coordinates,
        },
        checkedAt: new Date(),
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    logger.error("Failed to save reputation history", { error: err.message });
  }
}

/**
 * Search for safe alternative places nearby
 * Used when current or predicted location is high risk
 * @param {Array} coordinates - [lng, lat]
 * @param {string} country - Country code
 * @param {Object} options - { radius, types, userProfile }
 * @returns {Array} Safe alternatives sorted by rating and distance
 */
async function findSafeAlternatives(coordinates, country, options = {}) {
  const userProfile = options.userProfile || {};
  const demographics = userProfile.demographics || {};
  try {
    const [lng, lat] = coordinates;
    const radius = options.radius || 1000; // 1km radius

    // 1. Search map provider for nearby places
    const places = await multiMapProvider.getNearbyPlaces(coordinates, {
      radius,
      type: options.types || "tourist_attraction",
    });

    if (!places.places || places.places.length === 0) {
      logger.debug("No nearby places found for alternatives", { coordinates });
      return [];
    }

    // 2. Filter for high-rated & safe places
    const safePlaces = [];

    for (const place of places.places.slice(0, 10)) {
      // Limit to first 10
      // Skip low-rated places
      if (place.rating && place.rating < 3.5) continue;

      // Get coordinates from the unified format
      const placeCoords = Array.isArray(place.location)
        ? place.location
        : [
          place.location?.lng || place.longitude,
          place.location?.lat || place.latitude,
        ];

      if (!placeCoords[0] || !placeCoords[1]) continue;

      // Quick reputation check (cached only to be fast)
      const placeReputation = await checkReputation(placeCoords, {
        destinationCountry: country,
      });

      if (
        placeReputation.riskLevel === "safe" ||
        placeReputation.riskLevel === "low" ||
        (!placeReputation.shouldAlert && placeReputation.riskScore < 40)
      ) {
        const distance = tripStateManager.calculateDistance(
          coordinates,
          placeCoords,
        );

        // Personalization weighting
        let personalizationScore = 0;

        // 1. Age-based personalization
        if (demographics.age && demographics.age < 18) {
          if (
            place.types?.some((t) =>
              ["park", "museum", "cafe", "library"].includes(t),
            )
          ) {
            personalizationScore += 20;
          }
        }

        // 2. Gender-based personalization (Safety for women)
        if (demographics.gender === "female") {
          // Prioritize places that are typically safer/more populated/well-lit
          if (
            place.types?.some((t) =>
              ["shopping_mall", "cafe", "restaurant", "store"].includes(t),
            )
          ) {
            personalizationScore += 15;
          }
          // Weight more towards places with higher ratings (social proof)
          if (place.rating > 4.2) personalizationScore += 10;
        }

        safePlaces.push({
          name: place.name,
          coordinates: placeCoords,
          rating: place.rating || 4.0,
          personalizationScore,
          distance: Math.round(distance),
          distanceText:
            distance < 1000
              ? `${Math.round(distance)}m`
              : `${(distance / 1000).toFixed(1)}km`,
          types: place.types || [],
          riskLevel: placeReputation.riskLevel,
          address: place.address || place.vicinity || placeReputation.address,
        });
      }

      // Stop early if we have 3 good alternatives
      if (safePlaces.length >= 3) break;
    }

    // 3. Sort by rating, distance, and personalization (weighted)
    return safePlaces
      .sort((a, b) => {
        const scoreA =
          a.rating * 10 + a.personalizationScore - a.distance / 100;
        const scoreB =
          b.rating * 10 + b.personalizationScore - b.distance / 100;
        return scoreB - scoreA;
      })
      .slice(0, 3);
  } catch (err) {
    logger.error("Failed to find safe alternatives", {
      error: err.message,
      coordinates,
    });
    return [];
  }
}

const DANGER_KEYWORDS = searchEngineAggregator.DANGER_KEYWORDS || {
  en: [],
  ar: [],
};

module.exports = {
  checkReputation,
  checkLocationSafety: checkReputation, // Alias
  findSafeAlternatives,
  processLocationForReputation,
  sendReputationAlert,
  getReputationHistory,
  checkLocationManually,
  RISK_THRESHOLDS,
};
