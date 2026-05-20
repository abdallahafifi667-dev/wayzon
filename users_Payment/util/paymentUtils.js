const { logger } = require("../monitoring/metrics");
const { getUserWalletModel } = require("../models/users.models");

const COMMISSION_RATE = 0.08; // 8% commission
const COMMISSION_DEBT_THRESHOLD = 10;
const COMMISSION_OPERATION_THRESHOLD = 10;
const CANCELLATION_FEE_PERCENTAGE = 0.1;
const CANCELLATION_TIME_WINDOW_MINUTES = 30;
const PREMIUM_SAFETY_FEE = 1;

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
 * Deduct credits from user's wallet
 * @param {string|Object} userIdOrDoc - User ID
 * @param {number} amount - Number of credits to deduct
 */
async function deductCredits(userIdOrDoc, amount) {
  try {
    const userId = userIdOrDoc._id || userIdOrDoc;
    const UserWallet = getUserWalletModel();

    const result = await UserWallet.findOneAndUpdate(
      { userId: userId, credits: { $gte: amount } },
      { $inc: { credits: -amount } },
      { new: true }
    );

    if (!result) {
      throw new Error("Insufficient credits or wallet not found");
    }

    logger && logger.info && logger.info(`Deducted ${amount} credits from user ${userId}`);
    return result;
  } catch (err) {
    logger && logger.error && logger.error("Failed to deduct credits", { error: err.message });
    throw err;
  }
}

/**
 * Check if user can book next trip (no outstanding debt and sufficient credits)
 * Uses DUAL THRESHOLD logic: User is blocked if EITHER debt threshold OR operation count threshold is reached
 * @param {Object} wallet - UserWallet document
 * @param {number} requiredCredits - Credits needed for requested safety plan
 * @returns {Object} - { canBook: boolean, reason?: string, amount?: number }
 */
function canUserBookTrip(wallet, requiredCredits = 0) {
  // Handle case where null/undefined passed
  if (!wallet) return { canBook: requiredCredits <= 0 };

  // 1. Check for credits if required (Premium monitoring)
  if (requiredCredits > 0 && (!wallet.credits || wallet.credits < requiredCredits)) {
    return {
      canBook: false,
      reason: "INSUFFICIENT_CREDITS",
      amount: requiredCredits,
    };
  }

  // 2. DUAL THRESHOLD: Check commission debt amount (8% per trip)
  // Block if debt reaches $10 (approximately 2-3 trips worth of commission)
  if (wallet.commissionDebt && wallet.commissionDebt >= COMMISSION_DEBT_THRESHOLD) {
    return {
      canBook: false,
      reason: "COMMISSION_DEBT_THRESHOLD",
      amount: wallet.commissionDebt,
    };
  }

  // 3. DUAL THRESHOLD: Check trip count (alternative enforcement)
  // Block after 10 trips regardless of debt amount
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

  // 4. Legacy debt check (for backward compatibility)
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
  PREMIUM_SAFETY_FEE,
  calculateCommission,
  calculateCancellationFee,
  shouldApplyCancellationFee,
  applyCancellationFee,
  clearCommissionDebt,
  deductCredits,
  canUserBookTrip,
};
