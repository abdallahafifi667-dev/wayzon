/**
 * Coordinate Validator - التحقق من صحة الإحداثيات
 * يمنع أخطاء GPS الفادحة ويوفر تنسيق موحد
 */

class CoordinateValidationError extends Error {
  constructor(message, coordinates) {
    super(message);
    this.name = "CoordinateValidationError";
    this.coordinates = coordinates;
  }
}

/**
 * Validate [lng, lat] coordinates array
 * @param {Array} coordinates - [longitude, latitude] array
 * @throws {CoordinateValidationError} If coordinates are invalid
 * @returns {boolean} true if valid
 */
function validateCoordinates(coordinates) {
  // Check if array
  if (!Array.isArray(coordinates)) {
    throw new CoordinateValidationError(
      "Coordinates must be an array [lng, lat]",
      coordinates,
    );
  }

  // Check array length
  if (coordinates.length !== 2) {
    throw new CoordinateValidationError(
      `Coordinates array must have exactly 2 elements, got ${coordinates.length}`,
      coordinates,
    );
  }

  const [lng, lat] = coordinates;

  // Check if numbers
  if (typeof lng !== "number" || typeof lat !== "number") {
    throw new CoordinateValidationError(
      `Coordinates must be numbers, got lng: ${typeof lng}, lat: ${typeof lat}`,
      coordinates,
    );
  }

  // Check for NaN
  if (isNaN(lng) || isNaN(lat)) {
    throw new CoordinateValidationError(
      "Coordinates contain NaN values",
      coordinates,
    );
  }

  // Check longitude range (-180 to 180)
  if (lng < -180 || lng > 180) {
    throw new CoordinateValidationError(
      `Longitude must be between -180 and 180, got ${lng}`,
      coordinates,
    );
  }

  // Check latitude range (-90 to 90)
  if (lat < -90 || lat > 90) {
    throw new CoordinateValidationError(
      `Latitude must be between -90 and 90, got ${lat}`,
      coordinates,
    );
  }

  return true;
}

/**
 * Safe validate - returns false instead of throwing
 * @param {Array} coordinates - [longitude, latitude] array
 * @returns {{valid: boolean, error?: string}}
 */
function safeValidateCoordinates(coordinates) {
  try {
    validateCoordinates(coordinates);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Parse and validate coordinates from various formats
 * @param {any} input - Coordinates in various formats
 * @returns {Array} [lng, lat] array
 */
function parseCoordinates(input) {
  let coordinates;

  // Already an array
  if (Array.isArray(input)) {
    coordinates = input;
  }
  // Object with lng/lat or longitude/latitude
  else if (typeof input === "object" && input !== null) {
    const lng = input.lng ?? input.longitude ?? input.lon ?? input.x;
    const lat = input.lat ?? input.latitude ?? input.y;

    if (lng === undefined || lat === undefined) {
      throw new CoordinateValidationError(
        "Object must have lng/lat or longitude/latitude properties",
        input,
      );
    }

    coordinates = [parseFloat(lng), parseFloat(lat)];
  }
  // String format "lng,lat"
  else if (typeof input === "string") {
    const parts = input.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 2) {
      throw new CoordinateValidationError(
        "String format must be 'lng,lat'",
        input,
      );
    }
    coordinates = parts;
  } else {
    throw new CoordinateValidationError(
      `Unsupported coordinates format: ${typeof input}`,
      input,
    );
  }

  validateCoordinates(coordinates);
  return coordinates;
}

/**
 * Check if coordinates are within a reasonable distance (anti-spoofing)
 * @param {Array} prevCoords - Previous [lng, lat]
 * @param {Array} newCoords - New [lng, lat]
 * @param {number} maxDistanceKm - Maximum reasonable distance in km
 * @param {number} timeDiffSeconds - Time difference in seconds
 * @returns {{valid: boolean, speed?: number, maxSpeed?: number}}
 */
function validateMovement(
  prevCoords,
  newCoords,
  maxDistanceKm = 500,
  timeDiffSeconds = 60,
) {
  const R = 6371; // Earth radius in km

  const [lng1, lat1] = prevCoords;
  const [lng2, lat2] = newCoords;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  const speed = distance / (timeDiffSeconds / 3600); // km/h
  const maxSpeed = maxDistanceKm / (timeDiffSeconds / 3600);

  // 1000 km/h = supersonic, impossible for ground transport
  const impossibleSpeed = 1000;

  return {
    valid: distance <= maxDistanceKm && speed <= impossibleSpeed,
    distance,
    speed: Math.round(speed),
    maxSpeed: Math.round(maxSpeed),
    isImpossible: speed > impossibleSpeed,
  };
}

/**
 * Get country code from coordinates (rough approximation)
 * Uses simple bounding boxes for major countries
 * @param {Array} coordinates - [lng, lat]
 * @returns {string|null} Country code or null
 */
function approximateCountry(coordinates) {
  const [lng, lat] = coordinates;

  // Rough bounding boxes for major countries
  const countries = {
    // Middle East & North Africa
    EG: { minLng: 24.7, maxLng: 35.8, minLat: 22, maxLat: 31.7 }, // Egypt
    SA: { minLng: 34.5, maxLng: 55.7, minLat: 16.4, maxLat: 32.2 }, // Saudi Arabia
    AE: { minLng: 51, maxLng: 56.4, minLat: 22.6, maxLat: 26.1 }, // UAE
    KW: { minLng: 46.5, maxLng: 48.5, minLat: 28.5, maxLat: 30.1 }, // Kuwait
    QA: { minLng: 50.7, maxLng: 51.7, minLat: 24.5, maxLat: 26.2 }, // Qatar
    BH: { minLng: 50.3, maxLng: 50.8, minLat: 25.8, maxLat: 26.3 }, // Bahrain
    OM: { minLng: 52, maxLng: 59.8, minLat: 16.6, maxLat: 26.4 }, // Oman
    JO: { minLng: 34.9, maxLng: 39.3, minLat: 29.2, maxLat: 33.4 }, // Jordan
    LB: { minLng: 35.1, maxLng: 36.6, minLat: 33.1, maxLat: 34.7 }, // Lebanon
    IQ: { minLng: 38.8, maxLng: 48.6, minLat: 29.1, maxLat: 37.4 }, // Iraq
    SY: { minLng: 35.7, maxLng: 42.4, minLat: 32.3, maxLat: 37.3 }, // Syria
    YE: { minLng: 42.5, maxLng: 54, minLat: 12.1, maxLat: 19 }, // Yemen
    LY: { minLng: 9.4, maxLng: 25, minLat: 19.5, maxLat: 33 }, // Libya
    TN: { minLng: 7.5, maxLng: 11.6, minLat: 30.2, maxLat: 37.5 }, // Tunisia
    DZ: { minLng: -9, maxLng: 12, minLat: 19, maxLat: 37 }, // Algeria
    MA: { minLng: -13, maxLng: -1, minLat: 27.7, maxLat: 35.9 }, // Morocco

    // Asia
    CN: { minLng: 73.5, maxLng: 135, minLat: 18, maxLat: 54 }, // China
    JP: { minLng: 129, maxLng: 146, minLat: 31, maxLat: 46 }, // Japan
    KR: { minLng: 125, maxLng: 130, minLat: 33, maxLat: 39 }, // South Korea
    IN: { minLng: 68, maxLng: 97.5, minLat: 6, maxLat: 35.5 }, // India
    PK: { minLng: 60.8, maxLng: 77.8, minLat: 23.7, maxLat: 37 }, // Pakistan
    TH: { minLng: 97.3, maxLng: 105.6, minLat: 5.6, maxLat: 20.5 }, // Thailand
    VN: { minLng: 102.1, maxLng: 109.5, minLat: 8.4, maxLat: 23.4 }, // Vietnam
    MY: { minLng: 99.6, maxLng: 119.3, minLat: 0.9, maxLat: 7.4 }, // Malaysia
    SG: { minLng: 103.6, maxLng: 104, minLat: 1.2, maxLat: 1.5 }, // Singapore
    ID: { minLng: 95, maxLng: 141, minLat: -11, maxLat: 6 }, // Indonesia
    PH: { minLng: 116.9, maxLng: 126.6, minLat: 4.6, maxLat: 21.1 }, // Philippines

    // Europe
    RU: { minLng: 19, maxLng: 180, minLat: 41, maxLat: 82 }, // Russia
    UA: { minLng: 22, maxLng: 40.2, minLat: 44.4, maxLat: 52.4 }, // Ukraine
    TR: { minLng: 26, maxLng: 45, minLat: 36, maxLat: 42 }, // Turkey
    DE: { minLng: 5.8, maxLng: 15.1, minLat: 47.3, maxLat: 55 }, // Germany
    FR: { minLng: -5, maxLng: 9.6, minLat: 41.3, maxLat: 51.1 }, // France
    GB: { minLng: -8.2, maxLng: 1.8, minLat: 49.9, maxLat: 60.9 }, // UK
    ES: { minLng: -9.4, maxLng: 4.3, minLat: 36, maxLat: 43.8 }, // Spain
    IT: { minLng: 6.6, maxLng: 18.5, minLat: 36.6, maxLat: 47.1 }, // Italy
    NL: { minLng: 3.4, maxLng: 7.1, minLat: 50.8, maxLat: 53.5 }, // Netherlands
    BE: { minLng: 2.5, maxLng: 6.4, minLat: 49.5, maxLat: 51.5 }, // Belgium
    PT: { minLng: -9.5, maxLng: -6.2, minLat: 37, maxLat: 42.2 }, // Portugal
    PL: { minLng: 14.1, maxLng: 24.2, minLat: 49, maxLat: 54.8 }, // Poland
    AT: { minLng: 9.5, maxLng: 17, minLat: 46.4, maxLat: 49 }, // Austria
    CH: { minLng: 6, maxLng: 10.5, minLat: 45.8, maxLat: 47.8 }, // Switzerland
    GR: { minLng: 19.4, maxLng: 29.6, minLat: 34.8, maxLat: 41.7 }, // Greece

    // Americas
    US: { minLng: -125, maxLng: -66, minLat: 24, maxLat: 50 }, // USA (continental)
    CA: { minLng: -141, maxLng: -52, minLat: 41.7, maxLat: 83 }, // Canada
    MX: { minLng: -118, maxLng: -86, minLat: 14.5, maxLat: 32.7 }, // Mexico
    BR: { minLng: -74, maxLng: -34, minLat: -33.8, maxLat: 5.3 }, // Brazil
    AR: { minLng: -73.6, maxLng: -53.6, minLat: -55.1, maxLat: -21.8 }, // Argentina
    CL: { minLng: -75.6, maxLng: -66.4, minLat: -56, maxLat: -17.5 }, // Chile
    CO: { minLng: -79.1, maxLng: -66.9, minLat: -4.2, maxLat: 12.5 }, // Colombia
    VE: { minLng: -73.4, maxLng: -59.8, minLat: 0.6, maxLat: 12.2 }, // Venezuela

    // Africa
    ZA: { minLng: 16.5, maxLng: 32.9, minLat: -35, maxLat: -22.1 }, // South Africa
    NG: { minLng: 2.7, maxLng: 14.7, minLat: 4.3, maxLat: 13.9 }, // Nigeria
    KE: { minLng: 33.9, maxLng: 41.9, minLat: -4.7, maxLat: 4.6 }, // Kenya

    // Oceania
    AU: { minLng: 113, maxLng: 154, minLat: -44, maxLat: -10 }, // Australia
    NZ: { minLng: 166, maxLng: 179, minLat: -47.3, maxLat: -34.4 }, // New Zealand
  };

  for (const [code, bounds] of Object.entries(countries)) {
    if (
      lng >= bounds.minLng &&
      lng <= bounds.maxLng &&
      lat >= bounds.minLat &&
      lat <= bounds.maxLat
    ) {
      return code;
    }
  }

  return null;
}

module.exports = {
  validateCoordinates,
  safeValidateCoordinates,
  parseCoordinates,
  validateMovement,
  approximateCountry,
  CoordinateValidationError,
};
