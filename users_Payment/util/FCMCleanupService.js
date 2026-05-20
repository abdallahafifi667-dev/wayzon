const admin = require("firebase-admin");
const { getUserModel } = require("../models/users.models");
const queues = require("../config/bullQueue");
const { logUserAction } = require("../util/auditLogger");

class FCMCleanupService {
  constructor() {
    this.batchSize = 100;
    this.setupQueueProcessor();
    this.scheduleJobs();
  }

  /**
   * Setup Bull Queue Processor
   * Handles the actual cleanup logic when a job is processed
   */
  setupQueueProcessor() {
    queues.cleanup.process(async (job) => {
      try {
        if (job.data.type === "single_user") {
          return await this.cleanInvalidTokens(job.data.userId);
        } else {
          return await this.cleanupAllUsers(job);
        }
      } catch (error) {
        logUserAction({
          user: "system",
          action: "FCM Cleanup",
          details: {
            action: "cleanupAllUsers",
            error: error.message,
          },
        });
        throw error;
      }
    });
  }

  /**
   * Schedule recurring cleanup jobs
   */
  async scheduleJobs() {
    await queues.cleanup.add(
      { type: "all_users" },
      {
        repeat: { cron: "0 3 * * 1" },
        jobId: "weekly-fcm-cleanup",
        removeOnComplete: true,
      },
    );

    await queues.cleanup.add(
      { type: "daily_active_check" },
      {
        repeat: { cron: "0 4 * * *" },
        jobId: "daily-active-check",
        removeOnComplete: true,
      },
    );
  }

  /**
   * Clean invalid tokens for a specific user
   * @param {string} userId
   */
  async cleanInvalidTokens(userId) {
    try {
      const User = getUserModel();
      const user = await User.findById(userId).select("fcmTokens");

      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
        return 0;
      }

      const originalCount = user.fcmTokens.length;
      const validTokens = [];

      for (const token of user.fcmTokens) {
        try {
          await admin.messaging().send(
            {
              token,
              data: {
                type: "validation_test",
                timestamp: Date.now().toString(),
              },
            },
            { dryRun: true },
          );
          validTokens.push(token);
        } catch (error) {
          logUserAction({
            user: userId,
            action: "FCM Cleanup",
            details: {
              action: "cleanInvalidTokens",
              userId,
              error: error.message,
            },
          });
        }
      }

      const removedCount = originalCount - validTokens.length;

      if (removedCount > 0) {
        user.fcmTokens = validTokens;
        await user.save();
        logUserAction({
          user: userId,
          action: "FCM Cleanup",
          details: {
            action: "cleanInvalidTokens",
            userId,
            removedCount,
          },
        });
      }

      return validTokens.length;
    } catch (error) {
      logUserAction({
        user: userId,
        action: "FCM Cleanup",
        details: {
          action: "cleanInvalidTokens",
          userId,
          error: error.message,
        },
      });
      return 0;
    }
  }

  /**
   * Cleanup all users (Distributed Job)
   * @param {Object} job - Bull job object for progress tracking
   */
  async cleanupAllUsers(job) {
    try {
      const User = getUserModel();
      let processed = 0;
      let page = 0;
      const batchSize = this.batchSize;

      const totalUsers = await User.countDocuments({
        fcmTokens: { $exists: true, $ne: [] },
      });

      do {
        const users = await User.find({
          fcmTokens: { $exists: true, $ne: [] },
        })
          .select("_id fcmTokens")
          .skip(page * batchSize)
          .limit(batchSize)
          .lean();

        if (users.length === 0) break;

        for (const user of users) {
          await this.cleanInvalidTokens(user._id);
          processed++;
          if (job && totalUsers > 0) {
            job.progress(Math.round((processed / totalUsers) * 100));
          }
        }
        page++;

        if (users.length === batchSize) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } while (true);

      return { processed };
    } catch (error) {
      logUserAction({
        user: "system",
        action: "FCM Cleanup",
        details: {
          action: "cleanupAllUsers",
          error: error.message,
        },
      });
      throw error;
    }
  }

  /**
   * Public API to trigger cleanup for a user
   * Adds a job to the queue instead of running immediately
   */
  async cleanupUserTokens(userId) {
    return await queues.cleanup.add({
      type: "single_user",
      userId,
    });
  }
}

const fcmCleanupService = new FCMCleanupService();

module.exports = fcmCleanupService;
