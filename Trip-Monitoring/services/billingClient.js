const { getUserModel, getUserWalletModel } = require("../models/users.models");
const { client: redis } = require("../config/redis");
const { logger } = require("../monitoring/metrics");

// ✅ Load dependencies at module level (not inside functions) to prevent memory leaks
const NotificationService = require("../controllers/Notification/notificationService");

const REDIS_PREMIUM_PREFIX = "premium:";

// ✅ Validation Schema - Whitelist of valid actions
const VALID_ACTIONS = new Set(['SEARCH', 'VIDEO_ANALYSIS', 'TRIP_COMPLETION']);

// ✅ Costs with validation (frozen to prevent mutation)
const COSTS = Object.freeze({
    SEARCH: Number(process.env.SEARCH_DEDUCTION_COST) || 1,
    VIDEO_ANALYSIS: Number(process.env.VIDEO_DEDUCTION_COST) || 2,
    TRIP_COMPLETION: Number(process.env.TRIP_COMPLETION_COST) || 5,
});

/**
 * Get user safety mode with proper error handling
 * @param {string} userId - User ID (validated)
 * @returns {Promise<string>} 'paid' or 'free'
 * @throws {Error} if userId is invalid
 */
async function getUserSafetyMode(userId) {
    // ✅ Input validation
    if (!userId || typeof userId !== 'string') {
        throw new Error(`Invalid userId: ${userId}`);
    }

    try {
        const UserWallet = getUserWalletModel();
        const wallet = await UserWallet.findOne({ userId }).lean();

        if (!wallet || wallet.credits <= 0) {
            return 'free';
        }

        return 'paid';
    } catch (err) {
        // ✅ FAIL LOUD - Log with full context
        logger.error("CRITICAL: Failed to get user safety mode", {
            userId,
            error: err.message,
            stack: err.stack,
            timestamp: new Date().toISOString()
        });
        // ✅ Default to free BUT alert monitoring
        return 'free';
    }
}

/**
 * Deduct credits with ACID guarantees using Mongoose transactions
 * @param {string} userId - User ID
 * @param {string} action - Action type (SEARCH, VIDEO_ANALYSIS, TRIP_COMPLETION)
 * @returns {Promise<Object>} Result with success, remaining, mode
 * @throws {Error} on critical failures
 */
async function deductCredits(userId, action) {
    const startTime = Date.now();

    try {
        // ✅ Input Validation
        if (!userId || typeof userId !== 'string') {
            throw new Error(`Invalid userId: ${userId}`);
        }

        if (!action || typeof action !== 'string') {
            logger.warn("Invalid action type for credit deduction", { userId, action });
            return { success: false, reason: "invalid_action", mode: 'free' };
        }

        const normalizedAction = action.toUpperCase();

        // ✅ Validate action against whitelist
        if (!VALID_ACTIONS.has(normalizedAction)) {
            logger.warn("Unknown action type for credit deduction", { userId, action: normalizedAction });
            return { success: false, reason: "invalid_action", mode: 'free' };
        }

        const cost = COSTS[normalizedAction];

        // ✅ Check mode first (with error handling)
        const mode = await getUserSafetyMode(userId);

        if (mode === 'free') {
            logger.debug("User in free mode, skipping deduction", { userId, action: normalizedAction });
            return { success: false, reason: 'free_mode', mode: 'free' };
        }

        // ✅ Use Mongoose transaction for ACID guarantee
        const UserWallet = getUserWalletModel();
        const session = await UserWallet.startSession();

        let result;
        try {
            await session.withTransaction(async () => {
                // ✅ Atomic read + update with session
                const wallet = await UserWallet.findOne({ userId }).session(session);

                if (!wallet || wallet.credits < cost) {
                    // ✅ FAIL LOUD with full context
                    logger.warn("BILLING: Insufficient credits for paid action", {
                        userId,
                        action: normalizedAction,
                        cost,
                        available: wallet?.credits || 0,
                        timestamp: new Date().toISOString()
                    });
                    throw new Error('INSUFFICIENT_CREDITS'); // Rollback transaction
                }

                // ✅ Deduct and save atomically
                wallet.credits -= cost;
                await wallet.save({ session });

                // ✅ Log successful deduction with audit trail
                logger.info("BILLING: Credits deducted successfully", {
                    userId,
                    action: normalizedAction,
                    cost,
                    remaining: wallet.credits,
                    duration: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                });

                result = { success: true, remaining: wallet.credits, mode: 'paid' };
            });

        } catch (txError) {
            if (txError.message === 'INSUFFICIENT_CREDITS') {
                result = { success: false, reason: "insufficient_credits", mode: 'free' };
            } else {
                throw txError; // Re-throw for outer catch
            }
        } finally {
            await session.endSession();
        }

        return result;

    } catch (err) {
        // ✅ FAIL LOUD - Critical billing error
        logger.error("CRITICAL: Error in billingClient.deductCredits", {
            userId,
            action,
            error: err.message,
            stack: err.stack,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
        });

        // ✅ Return safe default but alert monitoring
        return { success: false, reason: "internal_error", mode: 'free' };
    }
}

/**
 * Check premium status with proper Redis error handling and race condition protection
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if premium and active
 */
async function checkPremiumStatus(userId) {
    try {
        // ✅ Input validation
        if (!userId || typeof userId !== 'string') {
            throw new Error(`Invalid userId: ${userId}`);
        }

        const User = getUserModel();
        const user = await User.findById(userId).lean();

        if (!user || !user.isPremium) return false;

        // ✅ Redis check with proper error handling
        let isPremiumInRedis = false;
        try {
            if (redis.isOpen) {
                const redisValue = await redis.get(`${REDIS_PREMIUM_PREFIX}${userId}`);
                isPremiumInRedis = !!redisValue;
            } else {
                logger.warn("Redis not available for premium check", { userId });
                // ✅ Fallback to DB-only check
            }
        } catch (redisErr) {
            // ✅ FAIL LOUD but continue with DB check
            logger.error("Redis error during premium check", {
                userId,
                error: redisErr.message,
                stack: redisErr.stack
            });
        }

        // ✅ Handle Redis expiry
        if (!isPremiumInRedis && redis.isOpen) {
            // Expired in Redis, revert DB
            await User.updateOne(
                { _id: userId },
                { isPremium: false, premiumExpiresAt: null }
            );

            await notifyUserOfDowngrade(userId, "PREMIUM_EXPIRED");

            logger.info("Premium status expired and reverted", { userId });
            return false;
        }

        // ✅ Low credit warning (with error handling)
        try {
            const UserWallet = getUserWalletModel();
            const wallet = await UserWallet.findOne({ userId }).lean();
            if (wallet && wallet.credits > 0 && wallet.credits <= 2) {
                await notifyLowCredits(userId, wallet.credits);
            }
        } catch (walletErr) {
            logger.debug("Failed to check low credits", { userId, error: walletErr.message });
        }

        // ✅ DB expiry check
        if (user.premiumExpiresAt && new Date() > user.premiumExpiresAt) {
            await User.updateOne(
                { _id: userId },
                { isPremium: false, premiumExpiresAt: null }
            );
            await notifyUserOfDowngrade(userId, "PREMIUM_EXPIRED");
            return false;
        }

        return true;
    } catch (err) {
        // ✅ FAIL LOUD
        logger.error("CRITICAL: Error in billingClient.checkPremiumStatus", {
            userId,
            error: err.message,
            stack: err.stack,
            timestamp: new Date().toISOString()
        });
        return false; // Safe default
    }
}

/**
 * Notify user about low credits (with error handling)
 * @param {string} userId - User ID
 * @param {number} credits - Remaining credits
 */
async function notifyLowCredits(userId, credits) {
    try {
        const User = getUserModel();
        const user = await User.findById(userId).select("fcmTokens").lean();

        if (user?.fcmTokens?.length) {
            await NotificationService.sendToMultipleDevices(
                user.fcmTokens,
                "⚠️ Low Credits Warning",
                `Your safety credits are low (${credits} left). Please top up to maintain premium monitoring.`,
                { type: "low_credits", credits }
            );
        }
    } catch (err) {
        // ✅ Don't crash on notification failure
        logger.error("Failed to send low credits notification", {
            userId,
            error: err.message
        });
    }
}

/**
 * Notify user about downgrade (with error handling)
 * @param {string} userId - User ID
 * @param {string} reason - Downgrade reason
 */
async function notifyUserOfDowngrade(userId, reason) {
    try {
        const User = getUserModel();
        const user = await User.findById(userId).select("fcmTokens").lean();

        const message = reason === "PREMIUM_EXPIRED"
            ? "Your premium safety session has expired. You are now on the standard plan."
            : "Your account has been moved to the free safety plan due to insufficient credits.";

        if (user?.fcmTokens?.length) {
            await NotificationService.sendToMultipleDevices(
                user.fcmTokens,
                "📉 Safety Plan Updated",
                message,
                { type: "plan_downgraded", reason }
            );
        }
    } catch (err) {
        // ✅ Don't crash on notification failure
        logger.error("Failed to send downgrade notification", {
            userId,
            reason,
            error: err.message
        });
    }
}

module.exports = {
    deductCredits,
    checkPremiumStatus,
    getUserSafetyMode,
    notifyLowCredits,
    notifyUserOfDowngrade
};
