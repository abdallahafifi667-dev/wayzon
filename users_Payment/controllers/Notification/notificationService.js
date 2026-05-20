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
  static async sendToDevice(token, title, body, data = {}) {
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

    try {
      if (!admin) {
        logger.log("Firebase not initialized, skipping notification", {
          error: "Firebase not initialized, skipping notification",
        });
        return { status: "skipped", message: "Firebase not available" };
      }

      const message = {
        token: token,
        notification: {
          title: title,
          body: body,
        },
        data: data,
        android: {
          priority: "high",
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
            },
          },
        },
      };

      const response = await admin.messaging().send(message);
      return { success: true, response };
    } catch (error) {
      logger.error("Error sending notification", { error });
      return { success: false, error: error.message };
    }
  }

  /**
   * إرسال إشعار إلى multiple devices
   */
  static async sendToMultipleDevices(tokens, title, body, data = {}) {
    // Validate payload shape before sending
    const { error } = validateDeviceNotification({ tokens, title, body, data });
    if (error) {
      return { success: false, error: formatValidationErrors(error) };
    }

    try {
      const message = {
        tokens: tokens,
        notification: {
          title: title,
          body: body,
        },
        data: data,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      return { success: true, response };
    } catch (error) {
      logger.error("Error sending multicast notification", { error });
      return { success: false, error: error.message };
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
