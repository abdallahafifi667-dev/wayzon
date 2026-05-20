const crypto = require("crypto");
const { logger } = require("../monitoring/metrics");
const { client: redisClient, connectRedis } = require("../config/redis");

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
 */
const cacheToken = async (tokenHash, decodedToken, ttl = 604800) => {
  try {
    if (!redisClient.isOpen) await connectRedis();

    const cacheKey = `token:${tokenHash}`;
    const cacheData = JSON.stringify({
      ...decodedToken,
      cachedAt: new Date().toISOString(),
    });

    await redisClient.setEx(cacheKey, ttl, cacheData);
    logger.debug("Token cached in Redis", { key: cacheKey });
  } catch (err) {
    logger.warn("Token caching error", { error: err.message });
  }
};

/**
 * Get cached token from Redis, falls back to DB if not found
 */
const getFromCacheOrDB = async (tokenHash, fallbackFn) => {
  try {
    if (!redisClient.isOpen) await connectRedis();

    const cacheKey = `token:${tokenHash}`;
    const data = await redisClient.get(cacheKey);

    if (data) {
      logger.debug("Token found in Redis cache");
      return JSON.parse(data);
    }

    logger.debug("Token not in cache, checking DB");
    const result = await fallbackFn();
    if (result) {
      await cacheToken(tokenHash, result);
    }
    return result;
  } catch (err) {
    logger.debug("Redis lookup failed, using DB", { error: err.message });
    return fallbackFn();
  }
};

/**
 * Clear cached token from Redis
 */
const clearTokenCache = async (tokenHash) => {
  try {
    if (!redisClient.isOpen) await connectRedis();

    const cacheKey = `token:${tokenHash}`;
    await redisClient.del(cacheKey);
    logger.debug("Token cache cleared", { key: cacheKey });
  } catch (err) {
    logger.warn("Token cache clearing error", { error: err.message });
  }
};

module.exports = {
  encrypt,
  decrypt,
  decryptCoordinates,
  cacheToken,
  getFromCacheOrDB,
  clearTokenCache,
};
