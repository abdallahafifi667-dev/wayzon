const admin = require("../../config/firebase");
const { logger } = require("../../monitoring/metrics");
const {
  validateDeviceNotification,
  formatValidationErrors,
} = require("../../validators/NotificationValidator");

class NotificationService {
  /**
   * إرسال إشعار إلى جهاز معين
   */
  static async sendToDevice(token, title, body, data = {}, retries = 3) {
    // Validate payload shape before sending
    const { error } = validateDeviceNotification({
      tokens: [token],
      title,
      body,
      data,
    });
    if (error) {
      return { success: false, error: formatValidationErrors(error) };
    }

    if (!admin) {
      logger.log("Firebase not initialized, skipping notification");
      return { status: "skipped", message: "Firebase not available" };
    }

    const message = {
      token: token,
      notification: { title, body },
      data: data,
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await admin.messaging().send(message);
        return { success: true, response };
      } catch (error) {
        if (attempt === retries) {
          logger.error(
            `Error sending notification (Attempt ${attempt}/${retries}):`,
            error,
          );
          return { success: false, error: error.message };
        }
        logger.warn(
          `Failed to send notification (Attempt ${attempt}/${retries}), retrying...`,
        );
        // Exponential backoff: 500ms, 1000ms, 2000ms
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * Math.pow(2, attempt - 1)),
        );
      }
    }
  }

  /**
   * إرسال إشعار إلى multiple devices
   */
  static async sendToMultipleDevices(
    tokens,
    title,
    body,
    data = {},
    retries = 3,
  ) {
    // Validate payload shape before sending
    const { error } = validateDeviceNotification({ tokens, title, body, data });
    if (error) {
      return { success: false, error: formatValidationErrors(error) };
    }

    const message = {
      tokens: tokens,
      notification: { title, body },
      data: data,
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await admin.messaging().sendEachForMulticast(message);
        return { success: true, response };
      } catch (error) {
        if (attempt === retries) {
          logger.error(
            `Error sending multicast notification (Attempt ${attempt}/${retries}):`,
            error,
          );
          return { success: false, error: error.message };
        }
        logger.warn(
          `Failed to send multicast notification (Attempt ${attempt}/${retries}), retrying...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * Math.pow(2, attempt - 1)),
        );
      }
    }
  }

  /**
   * إرسال إشعار لموضوع معين (Topic)
   */
  static async sendToTopic(topic, title, body, data = {}) {
    try {
      const message = {
        topic: topic,
        notification: {
          title: title,
          body: body,
        },
        data: data,
      };

      const response = await admin.messaging().send(message);
      return { success: true, response };
    } catch (error) {
      logger.error("Error sending topic notification", { error });
      return { success: false, error: error.message };
    }
  }
}

module.exports = NotificationService;
