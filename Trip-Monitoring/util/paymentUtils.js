const { logger } = require("../monitoring/metrics");
const { getUserWalletModel } = require("../models/users.models");

const COMMISSION_RATE = 0.05;
const COMMISSION_DEBT_THRESHOLD = 10;
const COMMISSION_OPERATION_THRESHOLD = 10;
const CANCELLATION_FEE_PERCENTAGE = 0.1;
const CANCELLATION_TIME_WINDOW_MINUTES = 30;

/**
 * Calculate 5% commission on order price
 * @param {number} orderPrice - Order price in currency
 * @returns {number} - Commission amount (5% of price)
 */
function calculateCommission(orderPrice) {
  return parseFloat((orderPrice * COMMISSION_RATE).toFixed(2));
}

/**
 * Calculate cancellation fee (10% of order price)
 * @param {number} orderPrice - Order price in currency
 * @returns {number} - Cancellation fee (10% of price)
 */
function calculateCancellationFee(orderPrice) {
  return parseFloat((orderPrice * CANCELLATION_FEE_PERCENTAGE).toFixed(2));
}

/**
 * Check if cancellation fee should be applied based on trip time
 * @param {Date} tripDate - Scheduled trip date/time
 * @param {Date} cancelDate - Cancel request date/time (default: now)
 * @returns {boolean} - true if fee should apply
 */
function shouldApplyCancellationFee(tripDate, cancelDate = new Date()) {
  const timeUntilTrip = tripDate.getTime() - cancelDate.getTime();
  const minutesUntilTrip = timeUntilTrip / (1000 * 60);
  return minutesUntilTrip <= CANCELLATION_TIME_WINDOW_MINUTES;
}

/**
 * Add commission to user's debt and track operation count
 * @param {string|Object} userIdOrDoc - User ID or object containing _id
 * @param {number} commission - Commission amount
 */
async function addCommissionDebt(userIdOrDoc, commission) {
  try {
    const userId = userIdOrDoc._id || userIdOrDoc;
    const UserWallet = getUserWalletModel();

    // Using atomic increment for safety
    const updatedWallet = await UserWallet.findOneAndUpdate(
      { userId: userId },
      {
        $inc: {
          commissionDebt: commission,
          commissionOperationCount: 1,
        },
      },
      { new: true, upsert: true }, // Upsert ensures wallet creation if missing
    );

    if (
      updatedWallet.commissionDebt >= COMMISSION_DEBT_THRESHOLD ||
      updatedWallet.commissionOperationCount >= COMMISSION_OPERATION_THRESHOLD
    ) {
      logger &&
        logger.warn &&
        logger.warn(`Commission threshold reached for user ${userId}`, {
          debt: updatedWallet.commissionDebt,
          operationCount: updatedWallet.commissionOperationCount,
        });
    }
  } catch (err) {
    logger &&
      logger.error &&
      logger.error("Failed to add commission debt", {
        error: err && err.message,
      });
    throw err;
  }
}

/**
 * Apply cancellation fee to tourist's account
 * Adds fee to pending balance (will be charged on next order)
 * @param {string|Object} touristIdOrDoc - Tourist User ID
 * @param {number} fee - Cancellation fee amount
 * @param {string|Object} guideIdOrDoc - Guide User ID (will receive the fee)
 */
async function applyCancellationFee(touristIdOrDoc, fee, guideIdOrDoc) {
  try {
    const touristId = touristIdOrDoc._id || touristIdOrDoc;
    const guideId = guideIdOrDoc._id || guideIdOrDoc;
    const UserWallet = getUserWalletModel();

    await Promise.all([
      UserWallet.findOneAndUpdate(
        { userId: touristId },
        { $inc: { commissionDebt: fee } },
        { upsert: true },
      ),
      UserWallet.findOneAndUpdate(
        { userId: guideId },
        { $inc: { balance: fee } },
        { upsert: true },
      ),
    ]);

    logger &&
      logger.info &&
      logger.info("Cancellation fee applied", {
        tourist: touristId,
        guide: guideId,
        fee: fee,
      });
  } catch (err) {
    logger &&
      logger.error &&
      logger.error("Failed to apply cancellation fee", {
        error: err && err.message,
      });
    throw err;
  }
}

/**
 * Clear commission debt after payment
 * @param {string|Object} userIdOrDoc - User ID or doc
 */
async function clearCommissionDebt(userIdOrDoc) {
  try {
    const userId = userIdOrDoc._id || userIdOrDoc;
    const UserWallet = getUserWalletModel();

    await UserWallet.findOneAndUpdate(
      { userId: userId },
      {
        $set: {
          commissionDebt: 0,
          commissionOperationCount: 0,
          lastCommissionPaymentDate: new Date(),
        },
      },
      { upsert: true },
    );

    logger &&
      logger.info &&
      logger.info(`Commission debt cleared for user ${userId}`, {
        userId: userId,
      });
  } catch (err) {
    logger &&
      logger.error &&
      logger.error("Failed to clear commission debt", {
        error: err && err.message,
      });
    throw err;
  }
}

/**
 * Check if user can book next trip (no outstanding debt)
 * @param {Object} wallet - UserWallet document (or object with wallet fields)
 * @returns {Object} - { canBook: boolean, reason?: string, amount?: number }
 */
function canUserBookTrip(wallet) {
  // Handle case where null/undefined passed
  if (!wallet) return { canBook: true }; // New user presumably

  if (
    wallet.commissionDebt &&
    wallet.commissionDebt >= COMMISSION_DEBT_THRESHOLD
  ) {
    return {
      canBook: false,
      reason: "COMMISSION_DEBT_THRESHOLD",
      amount: wallet.commissionDebt,
    };
  }

  if (
    wallet.commissionOperationCount &&
    wallet.commissionOperationCount >= COMMISSION_OPERATION_THRESHOLD
  ) {
    return {
      canBook: false,
      reason: "COMMISSION_OPERATIONS_THRESHOLD",
      count: wallet.commissionOperationCount,
      amount: wallet.commissionDebt,
    };
  }

  if (wallet.targetAccount && wallet.targetAccount >= 10) {
    return {
      canBook: false,
      reason: "LEGACY_DEBT_LIMIT",
      amount: wallet.targetAccount,
    };
  }

  return { canBook: true };
}

module.exports = {
  COMMISSION_RATE,
  COMMISSION_DEBT_THRESHOLD,
  COMMISSION_OPERATION_THRESHOLD,
  CANCELLATION_FEE_PERCENTAGE,
  CANCELLATION_TIME_WINDOW_MINUTES,
  calculateCommission,
  calculateCancellationFee,
  shouldApplyCancellationFee,
  addCommissionDebt,
  applyCancellationFee,
  clearCommissionDebt,
  canUserBookTrip,
};
