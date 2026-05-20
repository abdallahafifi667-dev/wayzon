/**
 * Layer 12: Video Risk Analyzer - Dynamic Video Intelligence
 *
 * Responsibilities:
 * 1. Dynamic Scanning: Only checks if "suspicion" is triggered.
 * 2. Short-Term Memory: Caches risks for 30 minutes (TTL).
 * 3. Age Verification: Ignores videos older than 30-60 minutes.
 * 4. Content Analysis: Uses Gemini to interpret video context/metadata.
 */

const { logger } = require("../../monitoring/metrics");
const { client: redis, connectRedis } = require("../../config/redis");
const searchAggregator = require("./helper/searchEngineAggregator");
const aiAnalyzer = require("./aiAnalyzer");
const { getModels } = require("../../models/ml.model");
const billingClient = require("../billingClient");


const CACHE_PREFIX = "video:risk:";
const RISK_TTL = 1800; // 30 minutes (Short-Term Memory)

class VideoRiskAnalyzer {
  /**
   * Check if a location has active video-confirmed risks
   * @param {Array} coordinates - [lng, lat]
   * @param {Object} context - Trigger reason (e.g. { reason: 'wrong_way', country: 'EG' })
   */
  async analyzeAreaRisks(coordinates, context = {}) {
    // ✅ Validate coordinates to prevent data pollution
    if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
      logger.error("Invalid coordinates format for video risk analysis", {
        coordinates,
        context: context.tripId,
      });
      return {
        status: "error",
        riskLevel: "unknown",
        error: "Invalid coordinates format",
      };
    }

    const [lng, lat] = coordinates;

    // ✅ Reject null island [0,0]
    if (lng === 0 && lat === 0) {
      logger.error("Rejected [0,0] coordinates in video risk analysis", {
        context: context.tripId,
      });
      return {
        status: "error",
        riskLevel: "unknown",
        error: "Invalid coordinates: [0,0] not allowed",
      };
    }

    // ✅ Validate coordinate ranges
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      logger.error("Coordinates out of valid range for video risk analysis", {
        coordinates,
        context: context.tripId,
      });
      return {
        status: "error",
        riskLevel: "unknown",
        error: "Coordinates out of valid range",
      };
    }

    const locationKey = `${Math.round(lat * 1000)}:${Math.round(lng * 1000)}`; // Approx 100m grid
    const cacheKey = `${CACHE_PREFIX}${locationKey}`;

    // 1. Check Short-Term Memory
    const cachedRisk = await this.checkCache(cacheKey);
    if (cachedRisk) {
      return {
        status: "cached_risk",
        ...cachedRisk,
        isCached: true,
      };
    }

    // 2. Decide if we should scan (Dynamic Trigger)
    // Only scan if suspicion exists or forced check
    if (!context.forceCheck && !this.shouldScan(context)) {
      return {
        status: "skipped",
        riskLevel: "unknown",
        reason: "no_suspicion",
      };
    }

    // 3. Perform Live Verification
    const locationName =
      (await this.reverseGeocode(lat, lng)) || "Unknown Location";
    const riskAnalysis = await this.performLiveVideoScan(locationName, context);

    // 4. Update Memory if Risk Found
    if (
      riskAnalysis.riskLevel === "danger" ||
      riskAnalysis.riskLevel === "warning"
    ) {
      await this.cacheRisk(cacheKey, riskAnalysis);
    }

    return riskAnalysis;
  }

  /**
   * Cache high-priority risks only
   */
  async cacheRisk(key, data) {
    try {
      if (!redis.isOpen) await connectRedis();
      await redis.setEx(
        key,
        RISK_TTL,
        JSON.stringify({
          ...data,
          timestamp: Date.now(),
        }),
      );
    } catch (err) {
      logger.error("Failed to cache video risk", { error: err.message });
    }
  }

  async checkCache(key) {
    try {
      if (!redis.isOpen) await connectRedis();
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Heuristic: Should we spend resources scanning this area?
   * 🆕 Enhanced: Security > Cost for high-risk countries
   */
  shouldScan(context) {
    if (context.hasDeviation) return true; // User went off-road
    if (context.isHighRiskCountry) return true; // Always scan in high-risk zones
    if (context.mlRiskLevel === "danger") return true; // ML Brain flagged it
    if (context.stoppedSuspiciously) return true; // Car stopped in weird place

    // 🆕 Security > Cost: Always scan in high-risk countries
    // These are countries with known instability or high crime
    const HIGH_RISK_COUNTRIES = [
      "SY",
      "IQ",
      "YE",
      "LY",
      "SO",
      "AF",
      "VE",
      "HT",
      "SS",
      "CF",
    ];
    if (HIGH_RISK_COUNTRIES.includes(context.country)) {
      return true;
    }

    return false;
  }

  /**
   * The core logic: Search -> Filter Old -> Smart Filter -> Thumbnail Analysis -> Verify
   * 🆕 Enhanced pipeline with cost optimization
   */
  async performLiveVideoScan(location, context = {}) {
    const country = context.country || "Global";
    const startTime = Date.now();

    // ✅ Deduct credits for Video Analysis Action
    if (context.userId) {
      await billingClient.deductCredits(context.userId, "VIDEO_ANALYSIS");
    }


    // A. Search for "Breaking" content (now includes YouTube real-time)
    const searchResults = await searchAggregator.searchRealTimeVideos(
      location,
      country,
      { userId: context.userId, skipDeduction: true },
    );


    if (!searchResults.length) {
      return { status: "clean", riskLevel: "safe", videoCount: 0 };
    }

    // B. Filter by recency score (>= 50 means recent enough)
    // 🆕 Now using scoring system instead of boolean
    const recentVideos = searchResults.filter((v) => {
      const snippetScore = this.isRecent(v.snippet);
      const titleScore = this.isRecent(v.title);
      const publishedAtScore = v.publishedAt ? this.isRecent(v.publishedAt) : 0;
      const maxScore = Math.max(
        snippetScore,
        titleScore,
        publishedAtScore,
        v.recencyScore || 0,
      );

      // Attach score for later sorting
      v.calculatedRecencyScore = maxScore;
      return maxScore >= 50; // Threshold for "recent enough"
    });

    if (!recentVideos.length) {
      return {
        status: "clean",
        riskLevel: "safe",
        note: "No recent videos found",
      };
    }

    // 🆕 C. SMART FILTER: Only proceed with videos that have danger keywords
    // This saves AI costs by filtering out irrelevant content
    const dangerVideos = recentVideos.filter((v) => this.hasDangerKeywords(v));

    // If no danger keywords, still analyze top 2 by recency as a safety net
    const videosToAnalyze =
      dangerVideos.length > 0
        ? dangerVideos.slice(0, 3)
        : recentVideos
          .sort(
            (a, b) =>
              (b.calculatedRecencyScore || 0) -
              (a.calculatedRecencyScore || 0),
          )
          .slice(0, 2);

    // 🆕 E. FETCH COMMENTS & METADATA FOR TRUTH VERIFICATION
    // Fetch detailed data for better vetting
    const enrichedVideos = await Promise.all(
      videosToAnalyze.map(async (v) => {
        if (v.source === "youtube_realtime" && v.videoId) {
          const comments = await searchAggregator.fetchYouTubeComments(
            v.videoId,
          );
          return { ...v, comments };
        }
        return v;
      }),
    );

    // 🆕 F. THUMBNAIL ANALYSIS (FREE extraction + AI vision)
    const thumbnailResults = [];
    for (const video of enrichedVideos) {
      if (video.videoId || video.thumbnail) {
        const thumbnails = video.videoId
          ? searchAggregator.extractYouTubeThumbnail(video.videoId)
          : { high: video.thumbnail };

        try {
          const thumbnailAnalysis = await aiAnalyzer.analyzeVideoThumbnail(
            thumbnails.high || thumbnails.medium || thumbnails.default,
            {
              location,
              videoTitle: video.title,
              scanType: context.scanType || "live_hazard",
            },
          );

          if (thumbnailAnalysis.hasVisibleDanger) {
            thumbnailResults.push({
              video: video,
              analysis: thumbnailAnalysis,
            });
          }
        } catch (err) {
          logger.debug("Thumbnail analysis skipped", {
            videoId: video.videoId,
            error: err.message,
          });
        }
      }
    }

    // 🆕 G. If thumbnails show danger, escalate immediately
    if (thumbnailResults.length > 0) {
      const highestUrgency = thumbnailResults.reduce((max, r) => {
        const urgencyScore = { critical: 4, high: 3, medium: 2, low: 1 };
        return urgencyScore[r.analysis.urgencyLevel] >
          urgencyScore[max.analysis.urgencyLevel]
          ? r
          : max;
      }, thumbnailResults[0]);

      const result = {
        status: "thumbnail_danger_detected",
        riskLevel:
          highestUrgency.analysis.urgencyLevel === "critical"
            ? "danger"
            : "warning",
        description: highestUrgency.analysis.description,
        dangerType: highestUrgency.analysis.dangerType,
        evidence: thumbnailResults.map((r) => ({
          url: r.video.url,
          title: r.video.title,
          dangerType: r.analysis.dangerType,
          confidence: r.analysis.confidence,
        })),
        timestamp: Date.now(),
        scanDuration: Date.now() - startTime,
        analysisMethod: "thumbnail_visual",
      };

      await this.saveVideoRiskToHistory(location, country, result, context);
      return result;
    }

    // H. Full AI Analysis on metadata + comments
    const aiVerdict = await aiAnalyzer.analyzeVideoMetadata({
      location,
      country,
      scanType:
        context.hasDeviation || context.stoppedSuspiciously
          ? "live_hazard"
          : "general_safety",
      videos: enrichedVideos.map((v) => ({
        title: v.title,
        snippet: v.snippet,
        url: v.url,
        source: v.source,
        timestamp: v.publishedAt || "recent",
        recencyScore: v.calculatedRecencyScore,
        comments: v.comments, // 🆕 Added comments for AI Truth Vetting
      })),
    });

    // 🆕 Truth Vetting Check
    if (aiVerdict.riskLevel !== "safe" && aiVerdict.truthConfidence < 40) {
      logger.debug("Video risk discarded due to low truth confidence", {
        location,
        aiVerdict,
      });
      return {
        status: "clean",
        riskLevel: "safe",
        note: "Potential misinformation detected",
      };
    }

    const finalResult = {
      status: "analyzed",
      riskLevel: aiVerdict.riskLevel,
      description: aiVerdict.summary,
      isVerifiedTruth: aiVerdict.isVerifiedTruth,
      truthConfidence: aiVerdict.truthConfidence,
      evidence: aiVerdict.keyVideos,
      timestamp: Date.now(),
      scanDuration: Date.now() - startTime,
      analysisMethod: "metadata_ai_with_comments",
    };

    // Phase 27: Persistent History for AI Training
    await this.saveVideoRiskToHistory(location, country, finalResult, context);

    return finalResult;
  }

  /**
   * Persist video risk data
   */
  async saveVideoRiskToHistory(location, country, result, context = {}) {
    try {
      const { SafetyEvent, SafetyAnalysisSnapshot } = getModels();

      // Normalize Risk Level
      const RISK_LEVEL_MAP = {
        safe: "safe",
        warning: "caution", // Video warnings are usually caution-level
        danger: "warning", // Video danger is serious enough for warning
      };
      const mappedRisk = RISK_LEVEL_MAP[result.riskLevel] || "unknown";

      // 1. Create a transient SafetyEvent
      const safetyEvent = await SafetyEvent.create({
        tripId: context.tripId || null,
        eventType: "video_risk_detected",
        category: "external",
        riskScore:
          result.riskLevel === "danger"
            ? 0.8
            : result.riskLevel === "warning"
              ? 0.5
              : 0.1,
        riskLevel: mappedRisk,
        location: {
          type: "Point",
          coordinates: context.coordinates || [0, 0],
        },
        decisionSummary: `Video Intelligence: ${result.description}`,
        hasSnapshot: true,
      });

      // 2. Save detailed evidence in Snapshot
      await SafetyAnalysisSnapshot.create({
        eventId: safetyEvent._id,
        tripId: context.tripId || null,
        layers: {
          videoRisk: result,
        },
        rawContext: {
          locationName: location,
          country: country,
          searchMetadata: result.evidence,
        },
        apiUsage: {
          geminiAI: true,
          googleMaps: false,
        },
      });
    } catch (err) {
      logger.debug("Failed to save video risk to safety events", {
        error: err.message,
      });
    }
  }

  /**
   * Helper to detect time indicators in text (ENHANCED)
   * Returns priority score: 100 = "Live/Just now", 80 = "minutes ago", etc.
   * @returns {number} Priority score (0 = not recent, higher = more recent)
   */
  isRecent(text) {
    if (!text) return 0;
    const normalized = text.toLowerCase();

    // 🆕 HIGHEST PRIORITY: Live streams and "Just now" (score: 100)
    const livePatterns = [
      "live",
      "just now",
      "breaking",
      "streaming",
      "live now",
      "🔴",
      "🔵", // Common live indicators
      // Arabic patterns
      "مباشر",
      "الآن",
      "بث مباشر",
      "عاجل",
    ];
    for (const pattern of livePatterns) {
      if (normalized.includes(pattern)) return 100;
    }

    // 🆕 HIGH PRIORITY: Very recent - under 10 minutes (score: 90)
    const veryRecentMatch = normalized.match(
      /(\d+)\s+(min|mins|minutes|دقائق|دقيقة)\s+(ago|مضت)?/,
    );
    if (veryRecentMatch) {
      const mins = parseInt(veryRecentMatch[1]);
      if (mins <= 10) return 90;
      if (mins <= 30) return 80;
      if (mins <= 60) return 70;
      return 50; // Still return true for any "X minutes ago"
    }

    // MEDIUM PRIORITY: Hours but within threshold (score: based on hours)
    const hoursMatch = normalized.match(
      /(\d+)\s+(hour|hr|hours|ساعة|ساعات)\s+(ago|مضت)?/,
    );
    if (hoursMatch) {
      const hours = parseInt(hoursMatch[1]);
      if (hours < 1) return 60;
      if (hours === 1) return 40; // 1 hour ago is borderline
      return 0; // More than 1 hour = not recent for real-time safety
    }

    // 🆕 Timestamp-based detection (for YouTube API results)
    // If the text looks like an ISO timestamp, calculate age
    const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (isoMatch) {
      const ageMs = Date.now() - new Date(isoMatch[0]).getTime();
      const ageMins = ageMs / 60000;
      if (ageMins < 5) return 100;
      if (ageMins < 15) return 90;
      if (ageMins < 30) return 80;
      if (ageMins < 60) return 70;
      return ageMins < 120 ? 50 : 0;
    }

    return 0;
  }

  /**
   * 🆕 Check if video title contains danger keywords (cost saver)
   */
  hasDangerKeywords(video) {
    const { containsDangerKeywords } = searchAggregator;
    const textToCheck = `${video.title || ""} ${video.snippet || ""}`;
    return containsDangerKeywords(textToCheck);
  }

  // Mock reverse geocode - in prod use mapVerifier
  async reverseGeocode(lat, lng) {
    // This should theoretically call mapVerifier or Nominatim
    // For now returning simple string to permit logic flow
    return `Lat ${lat.toFixed(4)}, Lng ${lng.toFixed(4)}`;
  }
}

module.exports = new VideoRiskAnalyzer();
