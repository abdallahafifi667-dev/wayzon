const { logger } = require("../monitoring/metrics");
const { getUserWalletModel } = require("../models/users.models");

const RemainingAccount = async (req, res, next) => {
  try {
    const user = req.user;
    const UserWallet = getUserWalletModel();
    const userWallet = await UserWallet.findOne({ userId: user._id });

    if (!userWallet) {
      // If wallet missing (migration issue), allow temporarily or fail safe?
      // We fail safe here assuming post-save hook creates it or migration ran.
      logger &&
        logger.error &&
        logger.error(`Wallet not found for user ${user._id}`);
      // For safety, we might mistakenly allow but logging is key.
      // If we block, we break existing users without migration.
      // Let's create it on the fly if missing?
      try {
        await UserWallet.create({ userId: user._id });
        // retry
        return RemainingAccount(req, res, next);
      } catch (e) {
        return res.status(500).json({
          message: "Account configuration error",
          code: "WALLET_NOT_FOUND",
        });
      }
    }

    if (userWallet.commissionDebt && userWallet.commissionDebt >= 10) {
      logger &&
        logger.warn &&
        logger.warn(
          `Commission debt payment required for user ${user._id}: $${userWallet.commissionDebt}`,
        );
      return res.status(403).json({
        message:
          "You must settle your pending commission fees before booking next trip",
        code: "COMMISSION_DEBT_REQUIRED",
        amount: userWallet.commissionDebt,
      });
    }

    if (
      userWallet.commissionOperationCount &&
      userWallet.commissionOperationCount >= 10
    ) {
      logger &&
        logger.warn &&
        logger.warn(`Commission operation limit reached for user ${user._id}`);
      return res.status(403).json({
        message:
          "You have reached the commission operation limit. Please settle your dues.",
        code: "COMMISSION_LIMIT_REACHED",
      });
    }

    if (userWallet.targetAccount && userWallet.targetAccount >= 50) {
      logger &&
        logger.warn &&
        logger.warn(
          `Account debt limit exceeded for user ${user._id}: $${userWallet.targetAccount}`,
        );
      return res.status(403).json({
        message: "Unfortunately, you owe more money than the permitted limit",
        code: "ACCOUNT_DEBT_EXCEEDED",
      });
    }

    next();
  } catch (error) {
    logger &&
      logger.error &&
      logger.error("RemainingAccount middleware error", {
        error: error && error.message,
      });
    return res.status(403).json({
      message: "Authorization check failed",
      error: `${error.message || error}`,
    });
  }
};

module.exports = {
  RemainingAccount,
};
