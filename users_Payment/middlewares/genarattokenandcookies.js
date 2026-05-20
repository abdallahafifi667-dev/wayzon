const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const {
  encrypt,
  decrypt,
  cacheToken,
  getFromCacheOrDB,
  clearTokenCache,
} = require("../util/encryption");
const { logger } = require("../monitoring/metrics");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required in environment variables");
}

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || "7d"; // 7 days
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || "365d"; // 365 days - infinite renewal

/**
 * Generate Access Token (7 days)
 * Short-lived token for API requests
 */
function generateAccessToken(user) {
  const email =
    user.email && user.email.address ? user.email.address : user.email;

  return jwt.sign(
    {
      role: user.role,
      id: user._id,
      email: email,
      type: "access",
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY },
  );
}

/**
 * Generate Refresh Token (30 days)
 * Long-lived token for getting new access tokens
 */
function generateRefreshToken(user) {
  const email =
    user.email && user.email.address ? user.email.address : user.email;

  return jwt.sign(
    {
      role: user.role,
      id: user._id,
      email: email,
      type: "refresh",
    },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY },
  );
}

/**
 * Generate both tokens (for login)
 */
function generateTokenPair(user) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  try {
    const encryptedAccess = encrypt(accessToken);
    const encryptedRefresh = encrypt(refreshToken);

    // Cache the tokens in Redis
    const accessHash = crypto
      .createHash("sha256")
      .update(encryptedAccess)
      .digest("hex");
    const decodedAccess = jwt.verify(accessToken, JWT_SECRET);
    cacheToken(accessHash, decodedAccess);

    return {
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      accessTokenExpiry: 7 * 24 * 60 * 60, // 7 days in seconds
      refreshTokenExpiry: 30 * 24 * 60 * 60, // 30 days in seconds
    };
  } catch (error) {
    logger.error("Token generation failed", {
      error: error.message,
      userId: user._id,
    });
    throw new Error("Failed to generate tokens");
  }
}

/**
 * Generate encrypted token (legacy - for backward compatibility)
 */
function generateEncryptedToken(user) {
  const email =
    user.email && user.email.address ? user.email.address : user.email;

  const token = jwt.sign(
    {
      role: user.role,
      id: user._id,
      email: email,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY },
  );
  try {
    const encryptedToken = encrypt(token);
    return encryptedToken;
  } catch (error) {
    logger.error("Token encryption failed", {
      error: error.message,
      userId: user._id,
    });
    throw new Error("Token encryption failed");
  }
}

/**
 * Send tokens to mobile app
 * @param {Object} user - User document
 * @param {Object} res - Express response object
 * @param {Object} extraBody - Optional extra data to include in JSON body
 */
exports.generateTokenAndSend = (user, res, extraBody = {}) => {
  const { accessToken, refreshToken, accessTokenExpiry } =
    generateTokenPair(user);

  // ✅ Send via headers (primary for mobile)
  res.setHeader("auth-token", accessToken);
  res.setHeader("refresh-token", refreshToken);

  // ✅ Send tokens and extra data in response body
  res.status(200).json({
    accessToken,
    refreshToken,
    accessTokenExpiry,
    tokenType: "Bearer",
    ...extraBody,
  });
};

/**
 * Verify and decrypt token (with Redis caching)
 * Checks Redis cache first, then DB
 */
exports.verifyAndDecryptToken = async (encryptedToken) => {
  try {
    // Check Redis cache first (fast path)
    const tokenHash = crypto
      .createHash("sha256")
      .update(encryptedToken)
      .digest("hex");

    const cached = await getFromCacheOrDB(tokenHash, async () => {
      // Fallback: decrypt and verify from encrypted token
      const decryptedToken = decrypt(encryptedToken);
      return jwt.verify(decryptedToken, JWT_SECRET);
    });

    if (cached) {
      logger.debug("Token verified (from cache or DB)");
      return cached;
    }

    throw new Error("Token verification failed");
  } catch (error) {
    logger.error("Token verification failed", {
      error: error.message,
    });
    throw new Error("Invalid or expired token");
  }
};

/**
 * Refresh access token using refresh token
 * Called when access token expires (7 days)
 * User NEVER forced to logout - indefinite automatic renewal
 * Also returns new refresh token (rolling window)
 */
exports.refreshAccessToken = (encryptedRefreshToken) => {
  try {
    const decryptedToken = decrypt(encryptedRefreshToken);
    const decoded = jwt.verify(decryptedToken, JWT_SECRET);

    if (decoded.type !== "refresh") {
      throw new Error("Invalid token type - expected refresh token");
    }

    // Generate NEW access token (7 days)
    const newAccessToken = jwt.sign(
      {
        role: decoded.role,
        id: decoded.id,
        email: decoded.email,
        type: "access",
      },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );

    const encryptedAccess = encrypt(newAccessToken);

    // Also generate NEW refresh token (rolling refresh for infinite session)
    const newRefreshToken = jwt.sign(
      {
        role: decoded.role,
        id: decoded.id,
        email: decoded.email,
        type: "refresh",
      },
      JWT_SECRET,
      { expiresIn: REFRESH_TOKEN_EXPIRY },
    );

    const encryptedRefresh = encrypt(newRefreshToken);

    // Cache the new access token
    const accessHash = crypto
      .createHash("sha256")
      .update(encryptedAccess)
      .digest("hex");
    const decodedAccess = jwt.verify(newAccessToken, JWT_SECRET);
    cacheToken(accessHash, decodedAccess);

    logger.info("Access token refreshed (rolling renewal)", {
      userId: decoded.id,
    });

    return {
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh, // Return new refresh token too
      accessTokenExpiry: 7 * 24 * 60 * 60,
    };
  } catch (error) {
    logger.error("Token refresh failed", {
      error: error.message,
    });
    throw new Error("Failed to refresh token");
  }
};

/**
 * Invalidate/revoke a token
 * Clears it from Redis cache
 */
exports.revokeToken = (encryptedToken) => {
  try {
    const tokenHash = crypto
      .createHash("sha256")
      .update(encryptedToken)
      .digest("hex");
    clearTokenCache(tokenHash);
    logger.info("Token revoked", { tokenHash });
  } catch (error) {
    logger.warn("Failed to revoke token", { error: error.message });
  }
};
