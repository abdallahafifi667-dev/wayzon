/**
 * Support Layer: Search Engine Aggregator - Multi-Search Engine Support
 * يجمع نتائج البحث من محركات متعددة لتحليل سمعة الأماكن
 *
 * Supports:
 * - Google Custom Search API
 * - Bing Search API
 * - DuckDuckGo (via instant answers)
 * - Yandex Search (for Russian content)
 */

const { logger } = require("../../../monitoring/metrics");
const { client: redis, connectRedis } = require("../../../config/redis");
const { retry, retryPresets } = require("../../../util/retryMechanism");
const billingClient = require("../../billingClient");

const {
  GeoConfig,
  DANGER_KEYWORDS: GEO_DANGER_KEYWORDS,
  SEARCH_ENGINES_BY_COUNTRY,
} = require("../../../config/geoConfig");

// API Configuration
const SEARCH_ENGINES = {
  google: {
    name: "Google Custom Search",
    baseUrl: "https://www.googleapis.com/customsearch/v1",
    apiKey: process.env.GOOGLE_SEARCH_API_KEY,
    cx: process.env.GOOGLE_SEARCH_CX, // Custom Search Engine ID
    enabled: true,
  },
  bing: {
    name: "Bing Search",
    baseUrl: "https://api.bing.microsoft.com/v7.0/search",
    apiKey: process.env.BING_SEARCH_API_KEY,
    enabled: true,
  },
  duckduckgo: {
    name: "DuckDuckGo",
    baseUrl: "https://api.duckduckgo.com",
    apiKey: null, // Free API
    enabled: true,
  },
  yandex: {
    name: "Yandex Search",
    baseUrl: "https://yandex.com/search/xml",
    apiKey: process.env.YANDEX_SEARCH_API_KEY,
    user: process.env.YANDEX_SEARCH_USER,
    enabled: true,
  },
  // 🆕 Real-Time Video Discovery - YouTube Data API
  youtube: {
    name: "YouTube Data API",
    baseUrl: "https://www.googleapis.com/youtube/v3/search",
    apiKey: process.env.YOUTUBE_API_KEY,
    enabled: true,
  },
};

// 🆕 Use GeoConfig for country-specific engines (replaces hardcoded COUNTRY_ENGINE_PRIORITY)
const COUNTRY_ENGINE_PRIORITY = SEARCH_ENGINES_BY_COUNTRY;

// Cache configuration
const CACHE_PREFIX = "search:cache:";
const CACHE_TTL = 86400; // 24 hours

// 🆕 Use GeoConfig for danger keywords (worldwide support)
const DANGER_KEYWORDS = GEO_DANGER_KEYWORDS;

const SAFE_KEYWORDS = {
  en: [
    "safe",
    "recommended",
    "tourist friendly",
    "popular",
    "beautiful",
    "amazing",
    "must visit",
  ],
  ar: ["آمن", "موصى", "سياحي", "شعبي", "جميل", "رائع"],
  ru: ["безопасно", "рекомендуется", "туристический", "популярный"],
  zh: ["安全", "推荐", "旅游", "热门", "美丽"],
  es: ["seguro", "recomendado", "turístico", "popular", "hermoso"],
  fr: ["sûr", "recommandé", "touristique", "populaire", "beau"],
  de: ["sicher", "empfohlen", "touristisch", "beliebt", "schön"],
  tr: ["güvenli", "tavsiye edilen", "turistik", "popüler", "güzel"],
  pt: ["seguro", "recomendado", "turístico", "popular", "bonito"],
};

/** محركات يدعمها `aggregateSearch` فقط (استبعاد baidu وغير المطبّق). */
const AGGREGATE_SUPPORTED_ENGINES = new Set([
  "google",
  "bing",
  "duckduckgo",
  "yandex",
]);

/**
 * قائمة معرفات المحركات لـ `aggregateSearch` حسب كود الدولة ISO2 أو "global".
 */
function getSearchEnginesForCountry(isoOrGlobal) {
  const key =
    !isoOrGlobal || isoOrGlobal === "global"
      ? "DEFAULT"
      : String(isoOrGlobal).toUpperCase();
  const list =
    COUNTRY_ENGINE_PRIORITY[key] || COUNTRY_ENGINE_PRIORITY.DEFAULT || [];
  const filtered = list.filter((e) => AGGREGATE_SUPPORTED_ENGINES.has(e));
  return filtered.length ? filtered : ["duckduckgo", "google"];
}

/**
 * Search using Google Custom Search API
 */
async function searchGoogle(query, options = {}) {
  const config = SEARCH_ENGINES.google;
  if (!config.apiKey || !config.cx) {
    logger.debug("Google Search API not configured, skipping.");
    return { engine: "google", results: [], totalResults: 0 };
  }

  return await retry(async () => {
    const params = new URLSearchParams({
      key: config.apiKey,
      cx: config.cx,
      q: query,
      num: options.limit || 10,
      ...(options.language && { lr: `lang_${options.language}` }),
    });

    const response = await fetch(`${config.baseUrl}?${params}`);
    if (!response.ok)
      throw new Error(`Google Search error: ${response.status}`);

    const data = await response.json();

    recordEngineStats("google", true);

    return {
      engine: "google",
      results: (data.items || []).map((item) => ({
        title: item.title,
        snippet: item.snippet,
        url: item.link,
        source: new URL(item.link).hostname,
      })),
      totalResults: parseInt(data.searchInformation?.totalResults || "0"),
    };
  }, retryPresets.api);
}

/**
 * Search using Bing Search API
 */
async function searchBing(query, options = {}) {
  const config = SEARCH_ENGINES.bing;
  if (!config.apiKey) {
    logger.debug("Bing Search API not configured, skipping.");
    return { engine: "bing", results: [], totalResults: 0 };
  }

  return await retry(async () => {
    const params = new URLSearchParams({
      q: query,
      count: options.limit || 10,
      mkt: options.market || "en-US",
    });

    const response = await fetch(`${config.baseUrl}?${params}`, {
      headers: {
        "Ocp-Apim-Subscription-Key": config.apiKey,
      },
    });
    if (!response.ok) throw new Error(`Bing Search error: ${response.status}`);

    const data = await response.json();

    recordEngineStats("bing", true);

    return {
      engine: "bing",
      results: (data.webPages?.value || []).map((item) => ({
        title: item.name,
        snippet: item.snippet,
        url: item.url,
        source: new URL(item.url).hostname,
      })),
      totalResults: data.webPages?.totalEstimatedMatches || 0,
    };
  }, retryPresets.api);
}

/**
 * Search using DuckDuckGo Instant Answers (Free, Limited)
 */
async function searchDuckDuckGo(query, options = {}) {
  return await retry(async () => {
    const params = new URLSearchParams({
      q: query,
      format: "json",
      no_html: 1,
      skip_disambig: 1,
    });

    const response = await fetch(
      `${SEARCH_ENGINES.duckduckgo.baseUrl}/?${params}`,
    );
    if (!response.ok) throw new Error(`DuckDuckGo error: ${response.status}`);

    const data = await response.json();

    recordEngineStats("duckduckgo", true);

    const results = [];

    // Abstract
    if (data.Abstract) {
      results.push({
        title: data.Heading || "Summary",
        snippet: data.Abstract,
        url: data.AbstractURL,
        source: data.AbstractSource,
      });
    }

    // Related topics
    for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(" - ")[0],
          snippet: topic.Text,
          url: topic.FirstURL,
          source: "duckduckgo",
        });
      }
    }

    return {
      engine: "duckduckgo",
      results,
      type: data.Type,
    };
  }, retryPresets.api);
}

/**
 * Search using Yandex XML Search (Russian content)
 */
async function searchYandex(query, options = {}) {
  const config = SEARCH_ENGINES.yandex;
  if (!config.apiKey || !config.user) {
    logger.debug("Yandex Search not configured, skipping.");
    return { engine: "yandex", results: [] };
  }

  const params = new URLSearchParams({
    user: config.user,
    key: config.apiKey,
    query: query,
    l10n: options.language || "ru",
    sortby: "rlv",
    groupby: `attr="".mode=flat.groups-on-page=${options.limit || 10}`,
  });

  const response = await fetch(`${config.baseUrl}?${params}`);
  if (!response.ok) throw new Error(`Yandex error: ${response.status}`);

  // Yandex returns XML, simplified parsing
  const text = await response.text();
  const results = [];

  // Simple regex extraction (in production use XML parser)
  const titleMatches = text.matchAll(/<title>([^<]+)<\/title>/g);
  const snippetMatches = text.matchAll(/<passage>([^<]+)<\/passage>/g);
  const urlMatches = text.matchAll(/<url>([^<]+)<\/url>/g);

  const titles = [...titleMatches].map((m) => m[1]);
  const snippets = [...snippetMatches].map((m) => m[1]);
  const urls = [...urlMatches].map((m) => m[1]);

  for (let i = 0; i < Math.min(titles.length, urls.length); i++) {
    results.push({
      title: titles[i],
      snippet: snippets[i] || "",
      url: urls[i],
      source: new URL(urls[i]).hostname,
    });
  }

  recordEngineStats("yandex", true);

  return {
    engine: "yandex",
    results,
  };
}

/**
 * 🆕 Real-Time YouTube Search - Catches videos within the last 60 minutes
 * Uses order=date to get the most recent uploads first
 * @param {string} query - Search query (location + keywords)
 * @param {Object} options - { maxAgeMins, limit }
 */
async function searchYouTubeRealTime(query, options = {}) {
  const config = SEARCH_ENGINES.youtube;
  if (!config.apiKey) {
    logger.debug("YouTube API not configured, skipping.");
    return { engine: "youtube", results: [], totalResults: 0 };
  }

  return await retry(async () => {

    const maxAgeMins = options.maxAgeMins || 60;
    const publishedAfter = new Date(
      Date.now() - maxAgeMins * 60 * 1000,
    ).toISOString();

    const params = new URLSearchParams({
      key: config.apiKey,
      part: "snippet",
      q: query,
      type: "video",
      order: "date", // 🔥 Critical: Get newest videos first
      publishedAfter: publishedAfter, // Only videos from last X minutes
      maxResults: options.limit || 10,
      relevanceLanguage: options.language || "en",
      safeSearch: "none", // We need to see uncensored content for safety
    });

    const response = await fetch(`${config.baseUrl}?${params}`);
    if (!response.ok) {
      throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    recordEngineStats("youtube", true);

    return {
      engine: "youtube",
      results: (data.items || []).map((item) => ({
        title: item.snippet.title,
        snippet: item.snippet.description,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        videoId: item.id.videoId,
        source: "youtube.com",
        publishedAt: item.snippet.publishedAt,
        thumbnail:
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.default?.url,
        channelTitle: item.snippet.channelTitle,
        // 🆕 Recency indicators for priority scoring
        isLive: item.snippet.liveBroadcastContent === "live",
        recencyScore: calculateRecencyScore(item.snippet.publishedAt),
      })),
      totalResults: data.pageInfo?.totalResults || 0,
    };
  }, retryPresets.api);
}

/**
 * 🆕 Fetch comments for truth verification
 * Scans top comments for keywords like "fake", "old", "staged", or confirmations
 * @param {string} videoId - YouTube Video ID
 */
async function fetchYouTubeComments(videoId) {
  return await retry(async () => {
    const config = SEARCH_ENGINES.youtube;
    if (!config.apiKey) return [];

    const params = new URLSearchParams({
      key: config.apiKey,
      part: "snippet",
      videoId: videoId,
      maxResults: 15,
      order: "relevance",
    });

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/commentThreads?${params}`,
    );
    if (!response.ok) return [];

    const data = await response.json();
    return (data.items || []).map((item) => ({
      text: item.snippet.topLevelComment.snippet.textDisplay,
      author: item.snippet.topLevelComment.snippet.authorDisplayName,
      likeCount: item.snippet.topLevelComment.snippet.likeCount,
    }));
  }, retryPresets.api);
}

/**
 * Calculate recency score (0-100) - higher = more recent
 */
function calculateRecencyScore(publishedAt) {
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageMins = ageMs / 60000;

  if (ageMins < 5) return 100; // Just now
  if (ageMins < 15) return 90; // Very recent
  if (ageMins < 30) return 70; // Recent
  if (ageMins < 60) return 50; // Within the hour
  return Math.max(0, 30 - Math.floor(ageMins / 60) * 5); // Decreases per hour
}

/**
 * 🆕 Extract YouTube Thumbnail URL - FREE, INSTANT
 * No API call needed - direct URL construction
 * @param {string} videoId - YouTube video ID
 * @param {string} quality - 'default', 'medium', 'high', 'maxres'
 * @returns {Object} Thumbnail URLs for different qualities
 */
function extractYouTubeThumbnail(videoId) {
  // YouTube provides predictable thumbnail URLs
  // This is FREE and doesn't count against API quota
  return {
    default: `https://img.youtube.com/vi/${videoId}/default.jpg`, // 120x90
    medium: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`, // 320x180
    high: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, // 480x360
    maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, // 1280x720
    // 🆕 Specific frame thumbnails (useful for analysis)
    frame1: `https://img.youtube.com/vi/${videoId}/1.jpg`,
    frame2: `https://img.youtube.com/vi/${videoId}/2.jpg`,
    frame3: `https://img.youtube.com/vi/${videoId}/3.jpg`,
  };
}

/**
 * 🆕 Danger keyword filter for cost optimization
 * Only proceed with AI analysis if title contains danger indicators
 */
const REALTIME_DANGER_KEYWORDS = {
  en: [
    "fire",
    "explosion",
    "accident",
    "crash",
    "shooting",
    "attack",
    "protest",
    "riot",
    "flood",
    "emergency",
    "help",
    "danger",
    "warning",
    "crowd",
    "panic",
    "fight",
    "violence",
  ],
  ar: [
    "حريق",
    "انفجار",
    "حادث",
    "إطلاق نار",
    "هجوم",
    "مظاهرة",
    "فيضان",
    "طوارئ",
    "مساعدة",
    "خطر",
    "تحذير",
    "ازدحام",
    "ذعر",
    "شجار",
    "عنف",
  ],
};

/**
 * Check if video title/snippet contains danger keywords
 */
function containsDangerKeywords(text, language = "en") {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const keywords = [
    ...(REALTIME_DANGER_KEYWORDS.en || []),
    ...(REALTIME_DANGER_KEYWORDS[language] || []),
  ];
  return keywords.some((kw) => normalized.includes(kw.toLowerCase()));
}

/**
 * Aggregate search from multiple engines
 * @param {string} query - Search query
 * @param {Object} options - { engines: [], language, limit, useCache }
 * @returns {Object} Aggregated results
 */
async function aggregateSearch(query, options = {}) {
  const selectedEngines = options.engines || ["duckduckgo", "google", "bing"];
  const cacheKey = `${CACHE_PREFIX}${Buffer.from(query).toString("base64").slice(0, 50)}`;

  // Check cache
  if (options.useCache !== false) {
    try {
      if (!redis.isOpen) await connectRedis();
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.fromCache = true;
        return parsed;
      }
    } catch (e) { }
  }

  // ✅ Deduct credits for Search Action (only if not from cache and not skipped)
  if (options.userId && !options.skipDeduction) {
    await billingClient.deductCredits(options.userId, "SEARCH");
  }


  const results = {
    query,
    timestamp: new Date().toISOString(),
    engines: {},
    allResults: [],
    errors: [],
  };

  const searchPromises = selectedEngines.map(async (engine) => {
    try {
      switch (engine) {
        case "google":
          return await searchGoogle(query, options);
        case "bing":
          return await searchBing(query, options);
        case "duckduckgo":
          return await searchDuckDuckGo(query, options);
        case "yandex":
          return await searchYandex(query, options);
        default:
          return null;
      }
    } catch (err) {
      recordEngineStats(engine, false, err.message);
      results.errors.push({ engine, error: err.message });
      return null;
    }
  });

  const searchResults = await Promise.allSettled(searchPromises);

  for (let i = 0; i < searchResults.length; i++) {
    const result = searchResults[i];
    if (result.status === "fulfilled" && result.value) {
      results.engines[selectedEngines[i]] = result.value;
      results.allResults.push(...result.value.results);

      // 🆕 "Drain" Logic: If DuckDuckGo returned enough data, we might skip paid engines for simple queries
      if (
        selectedEngines[i] === "duckduckgo" &&
        result.value.results.length >= 5 &&
        options.preferFree
      ) {
        logger.debug(
          "DuckDuckGo provided sufficient data, skipping paid engine to save cost",
        );
        break;
      }
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  results.allResults = results.allResults.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  // Cache result
  try {
    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(results));
  } catch (e) { }

  return results;
}

/**
 * Analyze search results for safety sentiment
 * @param {Array} results - Search results from aggregateSearch
 * @param {string} language - Language code
 * @returns {Object} Sentiment analysis
 */
function analyzeSentiment(results, language = "en") {
  const dangerWords = DANGER_KEYWORDS[language] || DANGER_KEYWORDS.en;
  const safeWords = SAFE_KEYWORDS[language] || SAFE_KEYWORDS.en;

  let dangerScore = 0;
  let safeScore = 0;
  const dangerHits = [];
  const safeHits = [];

  for (const result of results) {
    const text = `${result.title} ${result.snippet}`.toLowerCase();

    for (const word of dangerWords) {
      if (text.includes(word.toLowerCase())) {
        dangerScore += 2;
        dangerHits.push({ word, source: result.source, title: result.title });
      }
    }

    for (const word of safeWords) {
      if (text.includes(word.toLowerCase())) {
        safeScore += 1;
        safeHits.push({ word, source: result.source });
      }
    }
  }

  const totalScore = dangerScore + safeScore;
  const dangerRatio = totalScore > 0 ? dangerScore / totalScore : 0;

  let sentiment = "neutral";
  if (dangerRatio > 0.6) sentiment = "negative";
  else if (dangerRatio < 0.3 && safeScore > 0) sentiment = "positive";

  return {
    sentiment,
    dangerScore,
    safeScore,
    dangerRatio: Math.round(dangerRatio * 100),
    dangerHits: dangerHits.slice(0, 5),
    safeHits: safeHits.slice(0, 3),
    riskLevel:
      dangerRatio > 0.7 ? "high" : dangerRatio > 0.4 ? "medium" : "low",
  };
}

/**
 * Quick location safety search
 * @param {string} locationName - Name of the location
 * @param {string} country - Country name or code
 * @returns {Object} Safety analysis
 */
async function searchLocationSafety(locationName, country) {
  // 🆕 Optimized engine selection by country
  const countryCode = country.length === 2 ? country : "global";
  const engines = COUNTRY_ENGINE_PRIORITY[countryCode] || [
    "duckduckgo",
    "google",
  ];

  const queries = [
    `"${locationName}" ${country} safety reviews`,
    `"${locationName}" ${country} scam warning tourist`,
  ];

  const allResults = [];

  for (const query of queries) {
    try {
      const results = await aggregateSearch(query, {
        engines,
        limit: 5,
        useCache: true,
        preferFree: true, // 🆕 Use drain logic for location safety
      });
      allResults.push(...results.allResults);
    } catch (err) {
      logger.debug("Search query failed", { query, error: err.message });
    }
  }

  const sentiment = analyzeSentiment(allResults);

  return {
    location: locationName,
    country,
    resultsAnalyzed: allResults.length,
    ...sentiment,
    shouldAlert:
      sentiment.riskLevel === "high" || sentiment.dangerHits.length >= 3,
  };
}

/**
 * Track engine usage and failures (internal helper)
 */
function recordEngineStats(engine, success, error = null) {
  const config = SEARCH_ENGINES[engine];
  if (!config) return;

  config.stats = config.stats || {
    success: 0,
    failures: 0,
    lastError: null,
    lastUsed: null,
  };
  config.stats.lastUsed = new Date().toISOString();

  if (success) {
    config.stats.success++;
  } else {
    config.stats.failures++;
    config.stats.lastError = error;
  }
}

/**
 * Search specifically for real-time video/incident content
 * Reduced from 70 queries to 10 context-aware queries for Profit Protection
 */
async function searchRealTimeVideos(location, country, options = {}) {
  const allResults = [];


  // 🆕 PHASE 1: YouTube API for real-time videos (PRIORITY)
  // This catches content within 60 minutes - before Google indexes it
  try {
    if (SEARCH_ENGINES.youtube.apiKey) {
      const youtubeQuery = `${location} ${country}`;
      const youtubeResults = await searchYouTubeRealTime(youtubeQuery, {
        maxAgeMins: 60,
        limit: 10,
        language: country === "EG" || country === "SA" ? "ar" : "en",
      });

      // Add with high priority - these are REAL-TIME results
      youtubeResults.results.forEach((r) => {
        r.priority = "realtime";
        r.source = "youtube_realtime";
      });
      allResults.push(...youtubeResults.results);

      logger.debug("YouTube real-time search completed", {
        location,
        count: youtubeResults.results.length,
        liveCount: youtubeResults.results.filter((r) => r.isLive).length,
      });
    }
  } catch (err) {
    logger.debug(
      "YouTube real-time search failed, falling back to aggregators",
      { error: err.message },
    );
  }

  // 🆕 PHASE 2: Traditional search engines (fallback/supplement)
  const queries = [
    `"${location}" ${country} live video`,
    `"${location}" ${country} breaking news`,
    `"${location}" ${country} accident now`,
    `"${location}" ${country} protest live`,
    `"${location}" ${country} fight/crime`,
    `"${location}" ${country} explosion/bomb threat`,
    `"${location}" ${country} social unrest`,
    `"${location}" ${country} fire/flood outbreak`,
    `"${location}" ${country} emergency alert`,
    `"${location}" ${country} police operation`,
  ];

  // Platform-specific logic
  const isCIS = ["RU", "BY", "KZ", "UA"].includes(country);
  if (isCIS) {
    queries.push(`"${location}" site:vk.com`);
  } else {
    queries.push(`"${location}" site:tiktok.com`);
    queries.push(`"${location}" site:t.me`);
  }

  // 🆕 Optimized engine selection
  const engines = isCIS ? ["yandex", "duckduckgo"] : ["google", "bing"];
  const searchOptions = { engines, limit: 5, useCache: true, ...options };

  // Parallel search for speed
  const promises = queries.map((q) => aggregateSearch(q, searchOptions));

  const rawResults = await Promise.allSettled(promises);

  for (const res of rawResults) {
    if (res.status === "fulfilled" && res.value?.allResults) {
      allResults.push(...res.value.allResults);
    }
  }

  // Filter for video platforms or news sites
  const filteredResults = allResults.filter((r) => {
    const url = r.url.toLowerCase();
    return (
      url.includes("youtube.com") ||
      url.includes("facebook.com") ||
      url.includes("twitter.com") ||
      url.includes("news") ||
      url.includes("vimeo.com") ||
      url.includes("tiktok.com") ||
      (r.snippet && r.snippet.toLowerCase().includes("video"))
    );
  });

  // 🆕 Sort by priority and recency score
  return filteredResults.sort((a, b) => {
    // Live videos first
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    // Then by recency score
    return (b.recencyScore || 0) - (a.recencyScore || 0);
  });
}

/**
 * Get status of all search engines for monitoring
 */
function getSearchEngineStatus() {
  const status = {};
  for (const [id, engine] of Object.entries(SEARCH_ENGINES)) {
    status[id] = {
      name: engine.name,
      hasApiKey: !!engine.apiKey || id === "duckduckgo",
      enabled: engine.enabled,
      stats: engine.stats || {
        success: 0,
        failures: 0,
        lastError: null,
        lastUsed: null,
      },
    };
  }
  return status;
}

module.exports = {
  aggregateSearch,
  analyzeSentiment,
  searchLocationSafety,
  searchRealTimeVideos,
  getSearchEngineStatus,
  getSearchEnginesForCountry,
  // 🆕 Real-time video intelligence functions
  searchYouTubeRealTime,
  fetchYouTubeComments,
  extractYouTubeThumbnail,
  containsDangerKeywords,
  /** إعدادات واجهات المزودين (google/bing/…) — ليس خريطة دولة→محركات */
  SEARCH_ENGINES,
  REALTIME_DANGER_KEYWORDS,
  DANGER_KEYWORDS,
  SAFE_KEYWORDS,
  GeoConfig,
  /** خريطة الدولة → أسماء المحركات من geoConfig */
  ENGINE_IDS_BY_COUNTRY: COUNTRY_ENGINE_PRIORITY,
};
