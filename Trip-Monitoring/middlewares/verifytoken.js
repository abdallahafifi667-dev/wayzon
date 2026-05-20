const {
  getUserModel,
  getUserWalletModel,
  getUserKYCModel,
} = require("../models/users.models");
const { verifyAndDecryptToken } = require("./genarattokenandcookies");
const { logger } = require("../monitoring/metrics");

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required in environment variables");
}

const verifyTokenUpPhoto = async (req, res, next) => {
  const encryptedToken = req.headers["auth-token"];

  if (!encryptedToken) {
    return res.status(403).json({
      error: "Authentication required",
      code: "MISSING_TOKEN",
    });
  }

  try {
    const decoded = verifyAndDecryptToken(encryptedToken);

    const User = getUserModel();
    const UserWallet = getUserWalletModel();
    const UserKYC = getUserKYCModel();

    // 1. Fetch Core User
    const user = await User.findById(decoded.id)
      .select(
        "role username email phone avatar country notificationSettings location languages",
      )
      .lean();

    if (!user) {
      return res.status(403).json({
        error: "User not found",
        code: "USER_NOT_FOUND",
      });
    }

    // 2. Fetch Wallet & KYC (Parallel for performance)
    const [wallet, kyc] = await Promise.all([
      UserWallet.findOne({ userId: user._id }).lean(),
      UserKYC.findOne({ userId: user._id }).lean(),
    ]);

    // Auto-recover if missing (migration safety)
    if (!wallet) {
      // Log warning but proceed if we can?
      // Logic depends on wallet. We can't proceed safely without wallet info for payments
      // But for "UpPhoto" maybe we can?
      // Let's create empty placeholders if missing to avoid crashes
      await UserWallet.create({ userId: user._id });
    }

    // 3. Adapter: Attach Wallet/KYC fields to user object for backward compatibility
    if (wallet) {
      user.wallet = wallet.wallet;
      user.balance = wallet.balance;
      user.RemainingAccount = wallet.RemainingAccount;
      user.targetAccount = wallet.targetAccount;
      user.commissionDebt = wallet.commissionDebt;
      user.commissionOperationCount = wallet.commissionOperationCount;
    } else {
      // Defaults
      user.wallet = 0;
      user.balance = 0;
      user.RemainingAccount = 0;
      user.targetAccount = 0;
    }

    if (kyc) {
      user.documentation = kyc.documentation;
      user.identityNumber = kyc.identityNumber;
      user.identityType = kyc.identityType;
      user.documentPhoto = kyc.documentPhoto;
      user.guideDocument = kyc.guideDocument;
      user.kycAttempts = kyc.kycAttempts;
      user.riskScore = kyc.riskScore;
    } else {
      user.documentation = false;
    }

    // Map email.verified to okemail
    user.okemail = user.email.verified;

    const userEmail = user.email.address || user.email; // Handle both structure just in case partial migration

    // If token has old email format
    if (user.role !== decoded.role || userEmail !== decoded.email) {
      return res.status(401).json({
        error: "Token data mismatch",
        code: "TOKEN_DATA_MISMATCH",
      });
    }

    req.user = user;
    // Also attach the separate models if controllers want to use them explicitly
    req.userWallet = wallet;
    req.userKYC = kyc;

    next();
  } catch (error) {
    logger &&
      logger.warn &&
      logger.warn("Token verification failed", {
        error: error && error.message,
      });

    if (error.message && error.message.includes("expired")) {
      return res.status(401).json({
        error: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    if (error.message && error.message.includes("Invalid")) {
      return res.status(401).json({
        error: "Invalid token",
        code: "INVALID_TOKEN",
      });
    }

    return res.status(401).json({
      error: "Authentication failed",
      code: "AUTHENTICATION_FAILED",
    });
  }
};

const verifyToken = (req, res, next) => {
  verifyTokenUpPhoto(req, res, () => {
    // Check using the mapped properties
    if (!req.user.documentation || !req.user.okemail) {
      return res.status(403).json({
        error: "Account verification required",
        code: "VERIFICATION_REQUIRED",
      });
    }
    next();
  });
};

const verifyTokenAndAuthorization = (req, res, next) => {
  verifyToken(req, res, () => {
    if (req.user._id.toString() === req.params.id) {
      next();
    } else {
      res.status(403).json({
        error: "Access denied",
        code: "UNAUTHORIZED_ACCESS",
      });
    }
  });
};

module.exports = {
  verifyToken,
  verifyTokenUpPhoto,
  verifyTokenAndAuthorization,
};
