/**
 * Notification Queue Service - Smart Notification Queue
 *
 * Manages notifications intelligently:
 * - Rate limiting per user
 * - Priority queue for urgent notifications
 * - Deduplication to prevent repeats
 * - Quiet hours support
 */

const { logger } = require("../monitoring/metrics");
const { client: redis, connectRedis } = require("../config/redis");
const NotificationService = require("../controllers/Notification/notificationService");
const { getUserModel } = require("../models/users.models");
const TripNotificationHistory = require("../models/tripNotificationHistory.models");
const { getEmergencyAlertModel } = require("../models/emergencyAlert.models");
const { getChatModel } = require("../models/Chat.models");

// Configuration
const CONFIG = {
  maxPerMinute: 10, // Max notifications per user per minute
  maxPerHour: 50, // Max notifications per user per hour
  dedupeWindow: 300, // Seconds to consider duplicate notifications
  batchInterval: 1000, // Process batch every 1 second
  maxQueueSize: 10000, // ✅ Max queue size to prevent memory issues
  maxRetries: 3, // ✅ Max retry attempts for failed notifications
  retryBackoffMs: 2000, // ✅ Backoff between retries
  priorities: {
    URGENT: 1,
    HIGH: 2,
    NORMAL: 3,
    LOW: 4,
  },
};

// Redis keys
const RATE_KEY_PREFIX = "notif:rate:";
const DEDUPE_KEY_PREFIX = "notif:dedupe:";
const QUIET_KEY_PREFIX = "notif:quiet:";
const QUEUE_KEY = "notif:queue"; // ✅ Redis-backed queue
const DLQ_KEY = "notif:dlq"; // ✅ Dead letter queue
const PROCESSING_KEY = "notif:processing"; // ✅ Processing lock

let isProcessing = false;

/**
 * Queue a notification
 * @param {Object} notification - Notification details
 * @returns {Object} Queue status
 */
async function queueNotification(notification) {
  const {
    userId,
    title,
    body,
    data = {},
    priority = "NORMAL",
    dedupe = true,
    bypassQuietHours = false,
  } = notification;

  if (!userId) {
    throw new Error("userId is required");
  }

  try {
    // Check deduplication
    if (dedupe) {
      const isDupe = await isDuplicate(userId, title, body, data);
      if (isDupe) {
        logger.debug("Notification deduplicated", { userId, title });
        return { status: "deduplicated" };
      }
    }

    // Check quiet hours (unless bypassed)
    if (!bypassQuietHours && !["URGENT"].includes(priority)) {
      const inQuietHours = await isInQuietHours(userId);
      if (inQuietHours) {
        logger.debug("Notification queued for later (quiet hours)", {
          userId,
          title,
        });
        // Could store for later, but for now just skip
        return { status: "quiet_hours" };
      }
    }

    // ✅ Check queue size to prevent memory issues
    if (!redis.isOpen) await connectRedis();
    const queueSize = await redis.lLen(QUEUE_KEY);
    if (queueSize >= CONFIG.maxQueueSize) {
      logger.error("Notification queue full", {
        queueSize,
        maxSize: CONFIG.maxQueueSize,
        userId,
      });
      return { status: "queue_full", reason: "max_size_exceeded" };
    }

    // Add to queue
    const queuedNotification = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      title,
      body,
      data,
      priority: CONFIG.priorities[priority] || CONFIG.priorities.NORMAL,
      queuedAt: Date.now(),
      attempts: 0,
    };

    // ✅ Add to Redis-backed queue (persists across restarts)
    await redis.rPush(QUEUE_KEY, JSON.stringify(queuedNotification));

    logger.debug("Notification queued to Redis", {
      id: queuedNotification.id,
      userId,
      priority,
      queueSize: queueSize + 1,
    });

    return {
      status: "queued",
      id: queuedNotification.id,
      queueSize: queueSize + 1,
    };
  } catch (err) {
    logger.error("Failed to queue notification", {
      error: err.message,
      stack: err.stack,
      userId,
    });
    return { status: "error", reason: "internal_error" };
  }
}

/**
 * Check if notification is a duplicate or sticky (already sent for trip)
 * "Sticky Alert" Logic: Send ONCE per trip/hazard unless severity increases.
 * Also checks if user already sent emergency alert or chat message to avoid spam.
 */
async function isDuplicate(userId, title, body, data) {
  try {
    const { tripId, type, riskLevel } = data || {};

    // 1. If tripId is present, check persistent history (Sticky Alert)
    if (tripId && type) {
      const lastAlert = await TripNotificationHistory.findOne({
        tripId,
        type,
      }).sort({ sentAt: -1 });

      if (lastAlert) {
        // Allow re-alert ONLY if risk level escalated (e.g. medium -> critical)
        const severityMap = { low: 1, medium: 2, high: 3, critical: 4 };
        const oldSeverity = severityMap[lastAlert.riskLevel] || 1;
        const newSeverity = severityMap[riskLevel] || 1;

        if (newSeverity > oldSeverity) {
          logger.info("Escalated alert allowed", {
            tripId,
            type,
            oldSeverity,
            newSeverity,
          });
          return false; // Not a duplicate (Escalation)
        }

        logger.debug("Sticky Alert suppressed", { tripId, type });
        return true; // Duplicate (Sticky)
      }
    }

    // 2. 🆕 Check if user already sent an emergency alert for this trip
    // If user already reported emergency, don't keep bothering them
    if (tripId) {
      try {
        const EmergencyAlert = getEmergencyAlertModel();
        const existingEmergency = await EmergencyAlert.findOne({
          orderId: tripId,
          status: { $in: ["PENDING", "REVIEWED"] },
        }).lean();

        if (existingEmergency) {
          // Check if any response was already sent in last 30 minutes
          const recentResponse = existingEmergency.systemResponses?.find(
            (r) =>
              r.sentAt &&
              Date.now() - new Date(r.sentAt).getTime() < 30 * 60 * 1000,
          );
          if (recentResponse) {
            logger.info(
              "Notification suppressed - emergency alert already active",
              { tripId },
            );
            return true;
          }
        }
      } catch (err) {
        logger.debug("EmergencyAlert check failed", { error: err.message });
      }
    }

    // 3. 🆕 Check if user sent any emergency/help chat message recently
    // Don't spam user who already communicated they need help
    if (tripId && userId) {
      try {
        const Chat = getChatModel();
        const recentEmergencyChat = await Chat.findOne({
          orderId: tripId,
          from: userId,
          message: {
            $regex: /(help|emergency|sos|مساعدة|طوارئ|سوس|نجدة|خطر)/i,
          },
          createdAt: { $gt: new Date(Date.now() - 60 * 60 * 1000) }, // Last hour
        }).lean();

        if (recentEmergencyChat) {
          logger.info(
            "Notification suppressed - user already sent emergency message",
            {
              tripId,
              userId,
              messageTime: recentEmergencyChat.createdAt,
            },
          );
          return true;
        }
      } catch (err) {
        logger.debug("Chat emergency check failed", { error: err.message });
      }
    }

    // 4. Fallback to Redis short-term dedupe (for non-trip alerts)
    if (!redis.isOpen) await connectRedis();

    const hash = Buffer.from(`${title}:${body}`)
      .toString("base64")
      .slice(0, 50);
    const key = `${DEDUPE_KEY_PREFIX}${userId}:${hash}`;

    const exists = await redis.get(key);
    if (exists) return true;

    await redis.setEx(key, CONFIG.dedupeWindow, "1");
    return false;
  } catch (err) {
    logger.warn("Dedupe check failed", { error: err.message });
    return false; // Limit alerting on error
  }
}

/**
 * Save notification to history
 */
async function saveToHistory(notification) {
  try {
    const { tripId, type, riskLevel } = notification.data || {};
    if (tripId && type) {
      await TripNotificationHistory.create({
        tripId,
        userId: notification.userId,
        type,
        riskLevel: riskLevel || "medium",
        message: notification.body,
        metadata: notification.data,
      });
    }
  } catch (err) {
    logger.error("Failed to save notification history", { error: err.message });
  }
}

/**
 * Check rate limit for user
 */
async function checkRateLimit(userId) {
  try {
    if (!redis.isOpen) await connectRedis();

    const minuteKey = `${RATE_KEY_PREFIX}${userId}:min`;
    const hourKey = `${RATE_KEY_PREFIX}${userId}:hour`;

    const [minuteCount, hourCount] = await Promise.all([
      redis.get(minuteKey),
      redis.get(hourKey),
    ]);

    if (parseInt(minuteCount || "0") >= CONFIG.maxPerMinute) {
      return { allowed: false, reason: "minute_limit" };
    }
    if (parseInt(hourCount || "0") >= CONFIG.maxPerHour) {
      return { allowed: false, reason: "hour_limit" };
    }

    return { allowed: true };
  } catch (err) {
    return { allowed: true }; // Allow on Redis error
  }
}

/**
 * Increment rate limit counters
 */
async function incrementRateLimit(userId) {
  try {
    if (!redis.isOpen) await connectRedis();

    const minuteKey = `${RATE_KEY_PREFIX}${userId}:min`;
    const hourKey = `${RATE_KEY_PREFIX}${userId}:hour`;

    const multi = redis.multi();
    multi.incr(minuteKey);
    multi.expire(minuteKey, 60);
    multi.incr(hourKey);
    multi.expire(hourKey, 3600);
    await multi.exec();
  } catch (err) {
    logger.debug("Rate limit increment failed", { error: err.message });
  }
}

/**
 * Check if user is in quiet hours
 */
async function isInQuietHours(userId) {
  try {
    if (!redis.isOpen) await connectRedis();

    const key = `${QUIET_KEY_PREFIX}${userId}`;
    const quietSettings = await redis.get(key);

    if (!quietSettings) return false;

    const { start, end, timezone } = JSON.parse(quietSettings);

    // Get current hour in user's timezone (simplified, assume UTC offset)
    const now = new Date();
    const hour = now.getUTCHours() + (timezone || 0);

    // Check if in quiet hours (handles overnight range)
    if (start <= end) {
      return hour >= start && hour < end;
    } else {
      return hour >= start || hour < end;
    }
  } catch (err) {
    return false;
  }
}

/**
 * Set quiet hours for user
 * @param {string} userId - User ID
 * @param {number} start - Start hour (0-23)
 * @param {number} end - End hour (0-23)
 * @param {number} timezone - UTC offset
 */
async function setQuietHours(userId, start, end, timezone = 0) {
  try {
    if (!redis.isOpen) await connectRedis();

    const key = `${QUIET_KEY_PREFIX}${userId}`;
    await redis.set(key, JSON.stringify({ start, end, timezone }));

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Clear quiet hours
 */
async function clearQuietHours(userId) {
  try {
    if (!redis.isOpen) await connectRedis();
    await redis.del(`${QUIET_KEY_PREFIX}${userId}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Process notification queue from Redis
 * ✅ Reads from Redis-backed queue with retry and DLQ support
 */
async function processQueue() {
  if (isProcessing) return;

  isProcessing = true;

  try {
    if (!redis.isOpen) await connectRedis();

    // ✅ Check queue size
    const queueSize = await redis.lLen(QUEUE_KEY);
    if (queueSize === 0) {
      isProcessing = false;
      return;
    }

    // ✅ Process up to 10 notifications per batch
    const batchSize = Math.min(10, queueSize);
    const batch = [];

    for (let i = 0; i < batchSize; i++) {
      const item = await redis.lPop(QUEUE_KEY);
      if (item) {
        try {
          batch.push(JSON.parse(item));
        } catch (parseErr) {
          logger.error("Failed to parse queued notification", {
            error: parseErr.message,
            item,
          });
        }
      }
    }

    for (const notification of batch) {
      try {
        // Check rate limit
        const rateCheck = await checkRateLimit(notification.userId);
        if (!rateCheck.allowed) {
          // ✅ Re-queue with backoff
          notification.priority++;
          notification.attempts = (notification.attempts || 0) + 1;

          if (notification.attempts < CONFIG.maxRetries) {
            // ✅ Re-add to end of queue
            await redis.rPush(QUEUE_KEY, JSON.stringify(notification));
            logger.debug("Notification re-queued due to rate limit", {
              id: notification.id,
              attempts: notification.attempts,
            });
          } else {
            // ✅ Move to DLQ after max retries
            await redis.rPush(DLQ_KEY, JSON.stringify({
              ...notification,
              failedAt: new Date().toISOString(),
              reason: "max_retries_exceeded"
            }));
            logger.warn("Notification moved to DLQ", {
              id: notification.id,
              reason: "max_retries"
            });
          }
          continue;
        }

        // Get user tokens
        const User = getUserModel();
        const user = await User.findById(notification.userId)
          .select("fcmTokens")
          .lean();

        if (user && user.fcmTokens && user.fcmTokens.length > 0) {
          // ✅ Send real notification with retry
          const result = await NotificationService.sendToMultipleDevices(
            user.fcmTokens,
            notification.title,
            notification.body,
            notification.data,
          );

          if (!result.success) {
            notification.attempts = (notification.attempts || 0) + 1;

            // ✅ Retry with exponential backoff
            if (notification.attempts < CONFIG.maxRetries) {
              await new Promise((r) =>
                setTimeout(r, CONFIG.retryBackoffMs * notification.attempts),
              );
              await redis.rPush(QUEUE_KEY, JSON.stringify(notification));
              logger.warn("FCM send failed, retrying", {
                id: notification.id,
                attempts: notification.attempts,
                error: result.error,
              });
            } else {
              // ✅ Move to DLQ
              await redis.rPush(DLQ_KEY, JSON.stringify({
                ...notification,
                failedAt: new Date().toISOString(),
                reason: "fcm_send_failed",
                lastError: result.error
              }));
              logger.error("Notification moved to DLQ after FCM failures", {
                id: notification.id,
                error: result.error,
              });
            }
          } else {
            logger.debug("Notification sent via FCM", {
              id: notification.id,
              count: result.response?.successCount,
            });

            // Increment rate limit
            await incrementRateLimit(notification.userId);

            // Save to persistent history (Sticky Alert Logic)
            await saveToHistory(notification);
          }
        } else {
          logger.warn("No FCM tokens found for user", {
            userId: notification.userId,
            id: notification.id,
          });

          // ✅ Move to DLQ (no tokens = can't deliver)
          await redis.rPush(DLQ_KEY, JSON.stringify({
            ...notification,
            failedAt: new Date().toISOString(),
            reason: "no_fcm_tokens"
          }));
        }
      } catch (err) {
        logger.error("Failed to process notification", {
          id: notification.id,
          error: err.message,
          stack: err.stack,
        });

        // ✅ Move to DLQ on critical error
        try {
          await redis.rPush(DLQ_KEY, JSON.stringify({
            ...notification,
            failedAt: new Date().toISOString(),
            reason: "processing_error",
            lastError: err.message
          }));
        } catch (dlqErr) {
          logger.error("Failed to move to DLQ", {
            id: notification.id,
            error: dlqErr.message,
          });
        }
      }
    }
  } catch (err) {
    logger.error("Queue processing error", {
      error: err.message,
      stack: err.stack,
    });
  } finally {
    isProcessing = false;
  }
}

/**
 * Get queue statistics
 */
function getStats() {
  const byPriority = {};
  for (const n of queue) {
    const priorityName =
      Object.keys(CONFIG.priorities).find(
        (k) => CONFIG.priorities[k] === n.priority,
      ) || "UNKNOWN";
    byPriority[priorityName] = (byPriority[priorityName] || 0) + 1;
  }

  return {
    queueLength: queue.length,
    byPriority,
    isProcessing,
    oldestItem: queue[0]?.queuedAt ? Date.now() - queue[0].queuedAt : 0,
  };
}

/**
 * Clear queue
 */
function clearQueue() {
  const length = queue.length;
  queue.length = 0;
  return { cleared: length };
}

// Start queue processor
let processorInterval = null;

function startProcessor() {
  if (processorInterval) return;
  processorInterval = setInterval(processQueue, CONFIG.batchInterval);
  logger.info("Notification queue processor started");
}

function stopProcessor() {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
    logger.info("Notification queue processor stopped");
  }
}

// Auto-start on import
startProcessor();

module.exports = {
  queueNotification,
  setQuietHours,
  clearQuietHours,
  getStats,
  clearQueue,
  processQueue,
  startProcessor,
  stopProcessor,
  CONFIG,
};
