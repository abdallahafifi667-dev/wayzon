const jwt = require("jsonwebtoken");
const { encrypt, decrypt } = require("../util/encryption");
const { logger } = require("../monitoring/metrics");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required in environment variables");
}

const JWT_SECRET = process.env.JWT_SECRET;
function generateEncryptedToken(user) {
  // Handle nested email structure or legacy string
  const email =
    user.email && user.email.address ? user.email.address : user.email;

  const token = jwt.sign(
    {
      role: user.role,
      id: user._id,
      email: email,
      // IpPhone removed from schema
      // documentation moved to UserKYC
    },
    JWT_SECRET,
    { expiresIn: "7d" },
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

exports.generateTokenAndSend = (user, res) => {
  const encryptedToken = generateEncryptedToken(user);

  res.setHeader("auth-token", encryptedToken);
};

exports.verifyAndDecryptToken = (encryptedToken) => {
  try {
    const decryptedToken = decrypt(encryptedToken);
    const decoded = jwt.verify(decryptedToken, JWT_SECRET);
    return decoded;
  } catch (error) {
    logger.error("Token verification failed", {
      error: error.message,
    });
    throw new Error("Invalid or expired token");
  }
};
