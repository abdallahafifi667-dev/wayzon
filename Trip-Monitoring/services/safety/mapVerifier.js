/**
 * Map Verifier - طبقة 2: التحقق من الموقع
 * دعم متعدد لمزودي الخرائط حسب البلد والتوفر
 *
 * Supports:
 * - Google Maps (Default, worldwide)
 * - OpenStreetMap/Nominatim (Free, worldwide fallback)
 * - Baidu Maps (China)
 * - Yandex Maps (Russia/CIS)
 * - HERE Maps (Enterprise backup)
 */

const http = require("http");
const https = require("https");
const { logger } = require("../../monitoring/metrics");
const { client: redis, connectRedis } = require("../../config/redis");
const {
  approximateCountry,
} = require("../../validators/coordinates.validator");
const { getCircuitBreaker } = require("../../util/circuitBreaker");
const { retry, retryPresets } = require("../../util/retryMechanism");

// ✅ HTTP/HTTPS Connection Pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

// API Configuration
const PROVIDERS = {
  google: {
    name: "Google Maps",
    baseUrl: "https://maps.googleapis.com/maps/api",
    apiKey: process.env.GOOGLE_MAPS_API_KEY,
    countries: "*", // All countries
    priority: 1,
  },
  osm: {
    name: "OpenStreetMap",
    baseUrl: "https://nominatim.openstreetmap.org",
    apiKey: null, // Free API
    countries: "*",
    priority: 5, // Fallback
    rateLimit: 1000, // 1 req/sec
  },
  baidu: {
    name: "Baidu Maps",
    baseUrl: "https://api.map.baidu.com",
    apiKey: process.env.BAIDU_MAPS_API_KEY,
    countries: ["CN"], // China only
    priority: 1,
  },
  yandex: {
    name: "Yandex Maps",
    baseUrl: "https://geocode-maps.yandex.ru/1.x",
    apiKey: process.env.YANDEX_MAPS_API_KEY,
    countries: [
      "RU",
      "BY",
      "KZ",
      "UA",
      "UZ",
      "AZ",
      "AM",
      "GE",
      "MD",
      "TJ",
      "TM",
      "KG",
    ],
    priority: 1,
  },
  here: {
    name: "HERE Maps",
    baseUrl: "https://geocode.search.hereapi.com/v1",
    apiKey: process.env.HERE_API_KEY,
    countries: "*",
    priority: 3,
  },
};

// Cache keys
const CACHE_PREFIX = "map:cache:";
const CACHE_TTL = 3600; // 1 hour

// Circuit Breaker for provider failover
const circuitBreakers = new Map();
const CIRCUIT_OPEN_DURATION = 60000; // 1 minute

function recordSuccess(providerId) {
  const breaker = circuitBreakers.get(providerId) || {
    state: "closed",
    failures: 0,
  };
  breaker.failures = 0;
  breaker.state = "closed";
  circuitBreakers.set(providerId, breaker);
}

function recordFailure(providerId) {
  const breaker = circuitBreakers.get(providerId) || {
    state: "closed",
    failures: 0,
  };
  breaker.failures++;
  if (breaker.failures >= 3) {
    breaker.state = "open";
    breaker.openedAt = Date.now();
  }
  circuitBreakers.set(providerId, breaker);
}

const SAFE_PLACE_TYPES = [
  "restaurant",
  "cafe",
  "bar",
  "hotel",
  "lodging",
  "hostel",
  "motel",
  "gas_station",
  "tourist_attraction",
  "museum",
  "art_gallery",
  "park",
  "shopping_mall",
  "supermarket",
  "convenience_store",
  "bakery",
  "airport",
  "train_station",
  "bus_station",
  "subway_station",
  "ferry_terminal",
  "hospital",
  "clinic",
  "emergency_room",
  "pharmacy",
  "police",
  "fire_station",
  "library",
  "school",
  "kindergarten",
  "university",
  "college",
  "bank",
  "atm",
  "post_office",
  "community_center",
  "church",
  "mosque",
  "temple",
  "stadium",
  "sports_complex",
  "gym",
  "yoga_studio",
  "theater",
  "cinema",
  "zoo",
  "aquarium",
  "amusement_park",
  "beach",
  "lake",
  "river",
  "mountain_trail",
  "parking_lot",
  "public_square",
  "market",
  "medical_supply_store",
  "emergency_shelter",
  "fire_station_training_center",
  "police_training_center",
];

const RISKY_PLACE_TYPES = [
  "bar",
  "night_club",
  "casino",
  "strip_club",
  "cemetery",
  "storage",
  "warehouse",
  "construction_site",
  "abandoned_building",
  "industrial_area",
  "quarry",
  "shooting_range",
  "gun_shop",
  "weapons_store",
  "high_crime_area",
  "red_light_district",
  "prohibited_zone",
  "restricted_area",
  "military_base",
  "power_plant",
];

const SEARCH_RADIUS = 500;

/**
 * 🆕 Highly Optimized Provider Selection (Profit Protection)
 * Prioritizes local/cheaper providers to avoid expensive Google Maps calls.
 */
function selectProvider(coordinates) {
  const country = approximateCountry(coordinates);

  // 🌍 Optimized Global Fallback Ladder
  const priorityLadder = {
    CN: ["baidu", "here", "osm", "google"],
    RU: ["yandex", "here", "osm", "google"],
    BY: ["yandex", "here", "osm", "google"],
    KZ: ["yandex", "here", "osm", "google"],
    EG: ["osm", "here", "google"],
    SA: ["osm", "here", "google"],
    US: ["google", "here", "osm"],
    GB: ["google", "here", "osm"],
    DEFAULT: ["osm", "here", "google"], // 🆕 Prioritize OSM for Global
  };

  const ladder = priorityLadder[country] || priorityLadder["DEFAULT"];

  for (const pid of ladder) {
    const provider = PROVIDERS[pid];
    if (!provider || (!provider.apiKey && pid !== "osm")) continue;

    const breaker = getCircuitBreaker(`map:${pid}`, {
      failureThreshold: 3,
      timeout: 60000,
    });

    if (breaker.isAllowed()) {
      return pid;
    }
  }

  return "osm";
}

/**
 * Fetch nearby places using Google Maps
 */
async function fetchGooglePlaces(coordinates, options, config, providerId) {
  const breaker = getCircuitBreaker(`map:${providerId}`);
  const [lng, lat] = coordinates;

  try {
    return await breaker.execute(async () => {
      return await retry(async () => {
        const response = await fetch(
          `${config.baseUrl}/nearbysearch/json?location=${lat},${lng}&radius=${options.radius || SEARCH_RADIUS}&type=${options.type || ""}&key=${config.apiKey}`,
        );
        if (!response.ok)
          throw new Error(`Google Maps error: ${response.status}`);
        const data = await response.json();
        return data.results || [];
      }, retryPresets.api);
    });
  } catch (err) {
    throw err;
  }
}

/**
 * Fetch nearby places from Google Maps
 */
async function fetchFromGoogle(lat, lng, radius = 500) {
  const url = `${PROVIDERS.google.baseUrl}/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&key=${PROVIDERS.google.apiKey}`;

  // ✅ Use connection pooling
  const response = await fetch(url, { agent: httpsAgent });
  if (!response.ok) throw new Error(`Google API error: ${response.status}`);

  const data = await response.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Google API status: ${data.status}`);
  }

  return {
    provider: "google",
    places: (data.results || []).map((p) => ({
      name: p.name,
      types: p.types,
      location: [p.geometry.location.lng, p.geometry.location.lat],
      rating: p.rating,
      vicinity: p.vicinity,
    })),
    address: data.results[0]?.vicinity,
  };
}

/**
 * Fetch from OpenStreetMap/Nominatim (Free)
 */
async function fetchFromOSM(lat, lng, radius = 500) {
  // Reverse geocode first
  const reverseUrl = `${PROVIDERS.osm.baseUrl}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`;

  // ✅ Use connection pooling
  const reverseResponse = await fetch(reverseUrl, {
    headers: { "User-Agent": "TripMonitoring/1.0" },
    agent: httpsAgent,
  });
  if (!reverseResponse.ok)
    throw new Error(`OSM reverse error: ${reverseResponse.status}`);
  const reverseData = await reverseResponse.json();

  // Search nearby
  const searchUrl = `${PROVIDERS.osm.baseUrl}/search?format=json&q=*&lat=${lat}&lon=${lng}&radius=${radius}&limit=20`;
  const searchResponse = await fetch(searchUrl, {
    headers: { "User-Agent": "TripMonitoring/1.0" },
    agent: httpsAgent,
  });

  let places = [];
  if (searchResponse.ok) {
    const searchData = await searchResponse.json();
    places = searchData.map((p) => ({
      name: p.display_name?.split(",")[0] || "Unknown",
      types: [p.type, p.class].filter(Boolean),
      location: [parseFloat(p.lon), parseFloat(p.lat)],
      importance: p.importance,
    }));
  }

  return {
    provider: "osm",
    places,
    address: reverseData.display_name,
    locationType: reverseData.type,
  };
}

/**
 * Fetch from Baidu Maps (China)
 */
async function fetchFromBaidu(lat, lng, radius = 500) {
  if (!PROVIDERS.baidu.apiKey) throw new Error("Baidu API key not configured");

  const url = `${PROVIDERS.baidu.baseUrl}/place/v2/search?query=*&location=${lat},${lng}&radius=${radius}&output=json&ak=${PROVIDERS.baidu.apiKey}`;

  // ✅ Use connection pooling
  const response = await fetch(url, { agent: httpsAgent });
  if (!response.ok) throw new Error(`Baidu API error: ${response.status}`);

  const data = await response.json();
  if (data.status !== 0) throw new Error(`Baidu status: ${data.status}`);

  return {
    provider: "baidu",
    places: (data.results || []).map((p) => ({
      name: p.name,
      types: [p.detail_info?.tag],
      location: [p.location.lng, p.location.lat],
      address: p.address,
    })),
    address: data.results[0]?.address,
  };
}

/**
 * Fetch from Yandex Maps (Russia/CIS)
 */
async function fetchFromYandex(lat, lng, radius = 500) {
  if (!PROVIDERS.yandex.apiKey)
    throw new Error("Yandex API key not configured");

  const url = `${PROVIDERS.yandex.baseUrl}/?apikey=${PROVIDERS.yandex.apiKey}&geocode=${lng},${lat}&format=json&results=10`;

  // ✅ Use connection pooling
  const response = await fetch(url, { agent: httpsAgent });
  if (!response.ok) throw new Error(`Yandex API error: ${response.status}`);

  const data = await response.json();
  const featureMember = data.response?.GeoObjectCollection?.featureMember || [];

  return {
    provider: "yandex",
    places: featureMember.map((f) => {
      const geo = f.GeoObject;
      const pos = geo.Point?.pos?.split(" ") || [];
      return {
        name: geo.name,
        types: [geo.metaDataProperty?.GeocoderMetaData?.kind],
        location: [parseFloat(pos[0]), parseFloat(pos[1])],
        address: geo.description,
      };
    }),
    address:
      featureMember[0]?.GeoObject?.metaDataProperty?.GeocoderMetaData?.text,
  };
}

/**
 * Fetch from HERE Maps
 */
async function fetchFromHERE(lat, lng, radius = 500) {
  if (!PROVIDERS.here.apiKey) throw new Error("HERE API key not configured");

  const url = `${PROVIDERS.here.baseUrl}/revgeocode?at=${lat},${lng}&apiKey=${PROVIDERS.here.apiKey}`;

  // ✅ Use connection pooling
  const response = await fetch(url, { agent: httpsAgent });
  if (!response.ok) throw new Error(`HERE API error: ${response.status}`);

  const data = await response.json();
  const items = data.items || [];

  return {
    provider: "here",
    places: items.map((i) => ({
      name: i.title,
      types: [i.resultType],
      location: [i.position.lng, i.position.lat],
      address: i.address?.label,
    })),
    address: items[0]?.address?.label,
  };
}

/**
 * 🆕 Optimized Gridded Caching
 * Groups coordinates into ~500m cells to maximize cache hits.
 */
function getGridKey(lat, lng, radius) {
  const gridRes = 0.005; // ~550m resolution
  const gridLat = Math.round(lat / gridRes) * gridRes;
  const gridLng = Math.round(lng / gridRes) * gridRes;
  return `${CACHE_PREFIX}${gridLat.toFixed(3)},${gridLng.toFixed(3)}:${radius}`;
}

/**
 * Get nearby places with automatic provider selection
 * @param {Array} coordinates - [lng, lat]
 * @param {Object} options - { radius, forceProvider }
 * @returns {Object} Unified response
 */
async function getNearbyPlaces(coordinates, options = {}) {
  const [lng, lat] = coordinates;
  const radius = options.radius || 500;
  const cacheKey = getGridKey(lat, lng, radius);

  // Check cache first
  try {
    if (!redis.isOpen) await connectRedis();
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      parsed.fromCache = true;
      parsed.gridUsed = true;
      return parsed;
    }
  } catch (err) {
    logger.debug("Cache miss or error", { error: err.message });
  }

  // Select and try providers
  const providerId = options.forceProvider || selectProvider(coordinates);
  const fallbackOrder = ["google", "osm", "here", "yandex"];

  let lastError = null;
  const tried = new Set();

  // Try selected provider, then fallbacks
  const providersToTry = [
    providerId,
    ...fallbackOrder.filter((p) => p !== providerId),
  ];

  for (const pid of providersToTry) {
    if (tried.has(pid)) continue;
    tried.add(pid);

    const breaker = circuitBreakers.get(pid);
    if (
      breaker?.state === "open" &&
      Date.now() - breaker.openedAt < CIRCUIT_OPEN_DURATION
    ) {
      continue;
    }

    // 🆕 "Drain" Logic: If using OSM for Global, we try to gather everything
    const isGlobalDrain = pid === "osm" && !options.forceProvider;
    const currentRadius = isGlobalDrain ? Math.min(1000, radius * 2) : radius;
    try {
      let result;
      switch (pid) {
        case "google":
          result = await fetchFromGoogle(lat, lng, currentRadius);
          break;
        case "osm":
          result = await fetchFromOSM(lat, lng, currentRadius);
          break;
        case "baidu":
          result = await fetchFromBaidu(lat, lng, currentRadius);
          break;
        case "yandex":
          result = await fetchFromYandex(lat, lng, currentRadius);
          break;
        case "here":
          result = await fetchFromHERE(lat, lng, currentRadius);
          break;
        default:
          continue;
      }

      recordSuccess(pid);

      // Cache result
      try {
        await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(result));
      } catch (e) { }

      // 🆕 Complementary Logic: If OSM returned low data in global mode, don't stop, try next (Google)
      if (isGlobalDrain && result.places?.length < 3 && pid === "osm") {
        logger.debug(
          "OSM data sparse for global, escalating to complement with paid providers",
        );
        continue;
      }

      return result;
    } catch (err) {
      lastError = err;
      recordFailure(pid);
      logger.warn(`Map provider failed: ${pid}`, { error: err.message });
    }
  }

  // All failed
  throw new Error(
    `All map providers failed. Last error: ${lastError?.message}`,
  );
}

/**
 * Reverse geocode coordinates to address
 */
async function reverseGeocode(coordinates, options = {}) {
  const [lng, lat] = coordinates;

  try {
    const result = await getNearbyPlaces(coordinates, options);
    return {
      address: result.address,
      provider: result.provider,
      locationType: result.locationType,
    };
  } catch (err) {
    // Fallback to simple OSM
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
      // ✅ Use connection pooling
      const response = await fetch(url, {
        headers: { "User-Agent": "TripMonitoring/1.0" },
        agent: httpsAgent,
      });
      const data = await response.json();
      return {
        address: data.display_name,
        provider: "osm_fallback",
        locationType: data.type,
      };
    } catch (e) {
      return { address: null, provider: "none", error: e.message };
    }
  }
}

/**
 * Get provider status for monitoring
 */
function getProviderStatus() {
  const status = {};
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const breaker = circuitBreakers.get(id);
    status[id] = {
      name: provider.name,
      hasApiKey: !!provider.apiKey || id === "osm",
      countries: provider.countries,
      circuitState: breaker?.state || "closed",
      failures: breaker?.failures || 0,
    };
  }
  return status;
}

/**
 * Analyze places for safety assessment
 */
function analyzePlaces(places) {
  if (!places || !places.length) {
    return {
      locationType: "remote",
      safetyLevel: "unknown",
      recommendation: "use_ai_analysis",
      reason: "No nearby places found - possibly remote area",
    };
  }

  const safePlaces = [];
  const riskyPlaces = [];
  const allTypes = new Set();

  places.forEach((place) => {
    const types = place.types || [];
    types.forEach((t) => allTypes.add(t));

    const hasSafeType = types.some((t) => SAFE_PLACE_TYPES.includes(t));
    const hasRiskyType = types.some((t) => RISKY_PLACE_TYPES.includes(t));

    if (hasSafeType) safePlaces.push({ name: place.name, types });
    if (hasRiskyType) riskyPlaces.push({ name: place.name, types });
  });

  const isTouristArea =
    allTypes.has("tourist_attraction") ||
    allTypes.has("museum") ||
    allTypes.has("park");
  const isUrbanArea = allTypes.has("locality") || places.length > 5;
  const hasEmergencyServices =
    allTypes.has("hospital") ||
    allTypes.has("police") ||
    allTypes.has("fire_station");

  let safetyLevel = "safe";
  let recommendation = "continue_monitoring";

  if (riskyPlaces.length > safePlaces.length) {
    safetyLevel = "caution";
    recommendation = "monitor_closely";
  } else if (!safePlaces.length && !isUrbanArea) {
    safetyLevel = "unknown";
    recommendation = "use_ai_analysis";
  }

  const stopReasons = [];
  if (allTypes.has("restaurant") || allTypes.has("cafe"))
    stopReasons.push("eating");
  if (allTypes.has("gas_station")) stopReasons.push("refueling");
  if (allTypes.has("hotel") || allTypes.has("lodging"))
    stopReasons.push("accommodation");
  if (allTypes.has("tourist_attraction") || allTypes.has("museum"))
    stopReasons.push("sightseeing");
  if (allTypes.has("park")) stopReasons.push("rest_stop");

  return {
    locationType: isTouristArea
      ? "tourist"
      : isUrbanArea
        ? "urban"
        : "suburban",
    safetyLevel,
    recommendation,
    isTouristArea,
    isUrbanArea,
    hasEmergencyServices,
    possibleStopReasons: stopReasons,
    nearbyPlaces: {
      safe: safePlaces.slice(0, 5),
      risky: riskyPlaces.slice(0, 3),
    },
  };
}

/**
 * Verify location - combines fetching and analysis
 * @param {Array} coordinates - [lng, lat]
 * @param {Object} context - Additional context
 */
async function verifyLocation(coordinates, context = {}) {
  try {
    const mapResult = await getNearbyPlaces(coordinates, {
      radius: SEARCH_RADIUS,
    });
    const analysis = analyzePlaces(mapResult.places);
    const geoResult = await reverseGeocode(coordinates);

    return {
      status: "verified",
      provider: mapResult.provider,
      address: geoResult.address || mapResult.address,
      ...analysis,
      rawData: {
        placesCount: mapResult.places?.length || 0,
        address: geoResult.address || mapResult.address,
      },
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message,
      recommendation: "use_ai_analysis",
    };
  }
}

/**
 * Check if a stop is logical based on location
 */
async function checkIfStopIsLogical(
  coordinates,
  previousCoordinates,
  stoppedDuration,
) {
  const verification = await verifyLocation(coordinates);

  if (verification.status !== "verified") {
    return {
      logical: false,
      reason: "could_not_verify",
      recommendation: "use_ai_analysis",
    };
  }

  const hasValidReason = verification.possibleStopReasons?.length > 0;
  const isShortStop = stoppedDuration < 15 * 60 * 1000;
  const isTouristArea = verification.isTouristArea;

  if (hasValidReason || (isTouristArea && isShortStop)) {
    return {
      logical: true,
      reason: verification.possibleStopReasons?.[0] || "tourist_area",
      askUser: false,
    };
  }

  if (verification.safetyLevel === "safe" && isShortStop) {
    return { logical: true, reason: "short_safe_stop", askUser: false };
  }

  return {
    logical: false,
    reason: "unclear_stop_reason",
    recommendation: "ask_user",
    context: verification,
  };
}

/**
 * Fetch detailed place info including reviews (Google Maps)
 */
async function fetchPlaceDetails(placeId) {
  if (!PROVIDERS.google.apiKey)
    throw new Error("Google API key not configured");

  const url = `${PROVIDERS.google.baseUrl}/place/details/json?place_id=${placeId}&fields=name,rating,reviews,user_ratings_total,vicinity&key=${PROVIDERS.google.apiKey}`;

  // ✅ Use connection pooling
  const response = await fetch(url, { agent: httpsAgent });
  if (!response.ok)
    throw new Error(`Google Details API error: ${response.status}`);

  const data = await response.json();
  if (data.status !== "OK")
    throw new Error(`Google Details status: ${data.status}`);

  const p = data.result;
  return {
    name: p.name,
    rating: p.rating,
    totalRatings: p.user_ratings_total,
    vicinity: p.vicinity,
    reviews: (p.reviews || []).map((r) => ({
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      time: r.time, // Unix timestamp
      relativeTime: r.relative_time_description,
    })),
  };
}

/**
 * 🆕 Search for nearby places of a specific type
 * Used by locationReputationService.findSafeAlternatives
 * @param {Array} coordinates - [lng, lat]
 * @param {string} type - Place type (e.g., "point_of_interest")
 * @param {number} radius - Search radius in meters
 */
async function searchNearbyPlaces(coordinates, type, radius = 500) {
  try {
    const result = await getNearbyPlaces(coordinates, { radius, type });
    return result.places || [];
  } catch (err) {
    return [];
  }
}

module.exports = {
  // Multi-provider functions
  reverseGeocode,
  getProviderStatus,
  PROVIDERS,
  fetchPlaceDetails,
  getNearbyPlaces, // 🆕 Added
  // Place analysis functions
  verifyLocation,
  analyzePlaces,
  searchNearbyPlaces, // 🆕 Added
  checkIfStopIsLogical, // 🆕 Added
  SAFE_PLACE_TYPES,
  RISKY_PLACE_TYPES,
  SEARCH_RADIUS,
};
