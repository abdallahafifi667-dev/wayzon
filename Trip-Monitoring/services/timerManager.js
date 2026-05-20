/**
 * Timer Manager - إدارة مركزية للـ timers
 * يمنع memory leaks عن طريق تتبع وإلغاء الـ timers عند انتهاء الرحلة
 */

const { logger } = require("../monitoring/metrics");

class TimerManager {
  constructor() {
    // Map: tripId -> Set<{timerId, type, createdAt}>
    this.tripTimers = new Map();
    // Global timers not tied to specific trips
    this.globalTimers = new Map();
  }

  /**
   * Schedule a timer for a specific trip
   * @param {string} tripId - Trip identifier
   * @param {Function} callback - Function to execute
   * @param {number} delayMs - Delay in milliseconds
   * @param {string} type - Timer type for identification
   * @returns {number} Timer ID
   */
  schedule(tripId, callback, delayMs, type = "generic") {
    const timerId = setTimeout(async () => {
      try {
        // Remove from tracking before execution
        this._removeTimer(tripId, timerId);
        await callback();
      } catch (err) {
        logger.error("Timer callback error", {
          tripId,
          type,
          error: err.message,
        });
      }
    }, delayMs);

    // Track the timer
    if (!this.tripTimers.has(tripId)) {
      this.tripTimers.set(tripId, new Set());
    }

    this.tripTimers.get(tripId).add({
      timerId,
      type,
      createdAt: Date.now(),
      delayMs,
    });

    logger.debug("Timer scheduled", { tripId, type, delayMs, timerId });
    return timerId;
  }

  /**
   * Schedule a repeating interval for a trip
   * @param {string} tripId - Trip identifier
   * @param {Function} callback - Function to execute
   * @param {number} intervalMs - Interval in milliseconds
   * @param {string} type - Timer type for identification
   * @returns {number} Interval ID
   */
  scheduleInterval(tripId, callback, intervalMs, type = "interval") {
    const intervalId = setInterval(async () => {
      try {
        await callback();
      } catch (err) {
        logger.error("Interval callback error", {
          tripId,
          type,
          error: err.message,
        });
      }
    }, intervalMs);

    if (!this.tripTimers.has(tripId)) {
      this.tripTimers.set(tripId, new Set());
    }

    this.tripTimers.get(tripId).add({
      timerId: intervalId,
      type,
      isInterval: true,
      createdAt: Date.now(),
      intervalMs,
    });

    logger.debug("Interval scheduled", {
      tripId,
      type,
      intervalMs,
      intervalId,
    });
    return intervalId;
  }

  /**
   * Cancel a specific timer
   * @param {string} tripId - Trip identifier
   * @param {number} timerId - Timer ID to cancel
   */
  cancel(tripId, timerId) {
    const tripSet = this.tripTimers.get(tripId);
    if (!tripSet) return false;

    for (const timer of tripSet) {
      if (timer.timerId === timerId) {
        if (timer.isInterval) {
          clearInterval(timerId);
        } else {
          clearTimeout(timerId);
        }
        tripSet.delete(timer);
        logger.debug("Timer cancelled", { tripId, timerId, type: timer.type });
        return true;
      }
    }
    return false;
  }

  /**
   * Clear ALL timers for a specific trip (call on trip completion/cancellation)
   * @param {string} tripId - Trip identifier
   */
  clearAllForTrip(tripId) {
    const tripSet = this.tripTimers.get(tripId);
    if (!tripSet) {
      logger.debug("No timers to clear for trip", { tripId });
      return;
    }

    let clearedCount = 0;
    for (const timer of tripSet) {
      if (timer.isInterval) {
        clearInterval(timer.timerId);
      } else {
        clearTimeout(timer.timerId);
      }
      clearedCount++;
    }

    this.tripTimers.delete(tripId);
    logger.info("All timers cleared for trip", { tripId, clearedCount });
  }

  /**
   * Get timer stats for a trip
   * @param {string} tripId - Trip identifier
   * @returns {Object} Timer statistics
   */
  getStats(tripId) {
    const tripSet = this.tripTimers.get(tripId);
    if (!tripSet) return { count: 0, timers: [] };

    const timers = Array.from(tripSet).map((t) => ({
      type: t.type,
      createdAt: t.createdAt,
      ageMs: Date.now() - t.createdAt,
      isInterval: !!t.isInterval,
    }));

    return {
      count: timers.length,
      timers,
    };
  }

  /**
   * Get global timer statistics
   * @returns {Object} Global stats
   */
  getGlobalStats() {
    let totalTimers = 0;
    const tripStats = {};

    for (const [tripId, timers] of this.tripTimers.entries()) {
      totalTimers += timers.size;
      tripStats[tripId] = timers.size;
    }

    return {
      totalTrips: this.tripTimers.size,
      totalTimers,
      tripStats,
    };
  }

  /**
   * Internal: Remove a timer from tracking
   */
  _removeTimer(tripId, timerId) {
    const tripSet = this.tripTimers.get(tripId);
    if (!tripSet) return;

    for (const timer of tripSet) {
      if (timer.timerId === timerId) {
        tripSet.delete(timer);
        if (tripSet.size === 0) {
          this.tripTimers.delete(tripId);
        }
        return;
      }
    }
  }

  /**
   * Cleanup old timers (for maintenance)
   * Removes timers older than specified age
   * @param {number} maxAgeMs - Maximum age in milliseconds
   */
  cleanupOldTimers(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [tripId, timers] of this.tripTimers.entries()) {
      for (const timer of timers) {
        if (now - timer.createdAt > maxAgeMs) {
          if (timer.isInterval) {
            clearInterval(timer.timerId);
          } else {
            clearTimeout(timer.timerId);
          }
          timers.delete(timer);
          cleanedCount++;
        }
      }
      if (timers.size === 0) {
        this.tripTimers.delete(tripId);
      }
    }

    if (cleanedCount > 0) {
      logger.warn("Cleaned up old timers", { cleanedCount, maxAgeMs });
    }

    return cleanedCount;
  }
}

// Singleton instance
const timerManager = new TimerManager();

// Auto-cleanup every 4 hours
setInterval(
  () => {
    timerManager.cleanupOldTimers();
  },
  4 * 60 * 60 * 1000,
);

module.exports = timerManager;
