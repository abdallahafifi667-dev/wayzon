const crypto = require("crypto");
const { logger } = require("../monitoring/metrics");

// ✅ Redis caching (optional, for performance)
let redisClient = null;
try {
  const Redis = require("redis");
  redisClient = Redis.createClient({
    host: process.env.REDIS_HOST || "localhost",
    port: process.env.REDIS_PORT || 6379,
    db: process.env.REDIS_DB || 0,
    retryStrategy: (options) => {
      if (options.error && options.error.code === "ECONNREFUSED") {
        logger.warn("Redis connection refused - using DB fallback");
        return null; // Fallback to DB
      }
      if (options.total_retry_time > 1000 * 60 * 60) {
        return null;
      }
      return Math.min(options.attempt * 100, 3000);
    },
  });

  redisClient.on("error", (err) => {
    logger.warn("Redis error - using DB fallback", { error: err.message });
  });
} catch (err) {
  logger.warn("Redis not available - using DB fallback only");
  redisClient = null;
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_ALGORITHM = "aes-256-cbc";

if (!ENCRYPTION_KEY) {
  console.warn(
    "ENCRYPTION_KEY not set in environment. Using default (development only)",
  );
}

/**
 * @param {any} data - Data to encrypt (string or object)
 * @returns {string} - Encrypted data in format: iv:encryptedData
 *
 * SMART: Automatically handles both:
 * - JWT strings (no JSON.stringify)
 * - Objects (with JSON.stringify)
 */
const encrypt = (data) => {
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY || "dev-secret", "salt", 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

    // ✅ Smart: If data is string (JWT), use as-is. If object, stringify it.
    const dataToEncrypt =
      typeof data === "string" ? data : JSON.stringify(data);

    let encrypted = cipher.update(dataToEncrypt, "utf8", "hex");
    encrypted += cipher.final("hex");

    const result = iv.toString("hex") + ":" + encrypted;
    return result;
  } catch (error) {
    logger.error("Encryption error:", error.message);
    throw new Error("Failed to encrypt data");
  }
};

/**
 * @param {string} encryptedData - Encrypted data in format: iv:encryptedData
 * @returns {any} - Decrypted data (string or parsed object)
 *
 * SMART: Automatically handles both:
 * - JWT strings (returns raw string)
 * - JSON objects (returns parsed object)
 */
const decrypt = (encryptedData) => {
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY || "dev-secret", "salt", 32);

    const parts = encryptedData.split(":");
    if (parts.length !== 2) {
      throw new Error("Invalid encrypted data format");
    }

    const iv = Buffer.from(parts[0], "hex");
    const encrypted = parts[1];

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    // ✅ Smart: Try to parse as JSON. If it fails (JWT string), return raw string
    try {
      return JSON.parse(decrypted);
    } catch (parseError) {
      // Not JSON (probably JWT string), return as-is
      return decrypted;
    }
  } catch (error) {
    logger.error("Decryption error:", error.message);
    throw new Error("Failed to decrypt data");
  }
};

/**
 * @param {Array} coordinates - [longitude, latitude]
 * @returns {string} - Encrypted coordinates
 */
const encryptCoordinates = (coordinates) => {
  return encrypt({ coordinates, type: "Point" });
};

/**
 * @param {string} encryptedCoords - Encrypted coordinates
 * @returns {Array} - [longitude, latitude]
 */
const decryptCoordinates = (encryptedCoords) => {
  const data = decrypt(encryptedCoords);
  return data.coordinates;
};

// ============================================================================
// REDIS CACHING FOR TOKENS (Performance Optimization)
// ============================================================================

/**
 * Cache decrypted token in Redis for fast subsequent access
 * Reduces DB load during high traffic
 * @param {string} tokenHash - Hash of encrypted token (cache key)
 * @param {Object} decodedToken - Decoded JWT claims
 * @param {number} ttl - Time to live in seconds (7 days = 604800)
 */
const cacheToken = (tokenHash, decodedToken, ttl = 604800) => {
  if (!redisClient || !redisClient.connected) {
    logger.debug("Redis not available, skipping token cache");
    return; // Fail silently - DB will handle it
  }

  try {
    const cacheKey = `token:${tokenHash}`;
    const cacheData = JSON.stringify({
      ...decodedToken,
      cachedAt: new Date().toISOString(),
    });

    // Cache with TTL (expires automatically)
    redisClient.setex(cacheKey, ttl, cacheData, (err) => {
      if (err) {
        logger.warn("Failed to cache token in Redis", { error: err.message });
      } else {
        logger.debug("Token cached in Redis", { key: cacheKey });
      }
    });
  } catch (err) {
    logger.warn("Token caching error", { error: err.message });
  }
};

/**
 * Get cached token from Redis
 * Falls back to DB if not in Redis
 * @param {string} tokenHash - Hash of encrypted token
 * @param {Function} fallbackFn - Function to call if not in cache (DB query)
 * @returns {Promise} - Decoded token or null
 */
const getFromCacheOrDB = async (tokenHash, fallbackFn) => {
  // Try Redis first (fast path)
  if (redisClient && redisClient.connected) {
    return new Promise((resolve, reject) => {
      const cacheKey = `token:${tokenHash}`;
      redisClient.get(cacheKey, async (err, data) => {
        if (err) {
          logger.debug("Redis lookup failed, using DB", { error: err.message });
          resolve(await fallbackFn()); // Fallback to DB
        } else if (data) {
          logger.debug("Token found in Redis cache");
          resolve(JSON.parse(data));
        } else {
          logger.debug("Token not in cache, checking DB");
          const result = await fallbackFn();
          // Cache the result for next time
          if (result) {
            cacheToken(tokenHash, result);
          }
          resolve(result);
        }
      });
    });
  } else {
    // Redis not available, use DB directly
    logger.debug("Redis not available, using DB directly");
    return fallbackFn();
  }
};

/**
 * Clear cached token from Redis
 * Called when token is revoked/invalidated
 * @param {string} tokenHash - Hash of encrypted token
 */
const clearTokenCache = (tokenHash) => {
  if (!redisClient || !redisClient.connected) {
    return;
  }

  try {
    const cacheKey = `token:${tokenHash}`;
    redisClient.del(cacheKey, (err) => {
      if (err) {
        logger.warn("Failed to clear token cache", { error: err.message });
      } else {
        logger.debug("Token cache cleared", { key: cacheKey });
      }
    });
  } catch (err) {
    logger.warn("Token cache clearing error", { error: err.message });
  }
};

module.exports = {
  encrypt,
  decrypt,
  encryptCoordinates,
  decryptCoordinates,
  cacheToken,
  getFromCacheOrDB,
  clearTokenCache,
};
