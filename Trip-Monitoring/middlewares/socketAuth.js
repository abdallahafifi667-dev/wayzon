const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/**
 * Decrypt encrypted token from socket handshake
 * @param {string} encryptedToken
 * @returns {string|null} Decrypted token or null if failed
 */
const decryptToken = (encryptedToken) => {
  try {
    const CRYPTO_SECRET = process.env.CRYPTO_SECRET;
    if (!CRYPTO_SECRET) {
      throw new Error("Missing CRYPTO_SECRET in environment");
    }

    const [ivHex, saltHex, encryptedHex] = encryptedToken.split(":");
    if (!ivHex || !saltHex || !encryptedHex) {
      return null;
    }

    const iv = Buffer.from(ivHex, "hex");
    const salt = saltHex;
    const key = crypto.scryptSync(CRYPTO_SECRET, salt, 32);
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  } catch (error) {
    console.error("Token decryption failed:", error.message);
    return null;
  }
};

/**
 * Verify JWT token from decrypted string
 * @param {string} token
 * @returns {string|null} User ID or null if invalid
 */
const verifySocketToken = (token) => {
  try {
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      throw new Error("Missing JWT_SECRET in environment");
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.id) {
      throw new Error("Invalid token structure");
    }

    return decoded.id;
  } catch (error) {
    console.error("JWT verification failed:", error.message);
    return null;
  }
};

/**
 * Authenticate socket connection
 * Validates encrypted token and returns userId on success
 * @param {object} socket - Socket.io socket instance
 * @returns {string|null} userId if authenticated, null if failed
 */
const authenticateSocket = (socket) => {
  try {
    const encryptedToken = socket.handshake.auth.token;

    if (!encryptedToken) {
      console.warn("Socket connection attempt without token:", socket.id);
      return null;
    }

    const decryptedToken = decryptToken(encryptedToken);
    if (!decryptedToken) {
      console.warn("Token decryption failed for socket:", socket.id);
      return null;
    }

    const userId = verifySocketToken(decryptedToken);
    if (!userId) {
      console.warn("JWT verification failed for socket:", socket.id);
      return null;
    }

    return userId;
  } catch (error) {
    console.error("Socket authentication error:", error.message);
    return null;
  }
};

module.exports = {
  decryptToken,
  verifySocketToken,
  authenticateSocket,
};
