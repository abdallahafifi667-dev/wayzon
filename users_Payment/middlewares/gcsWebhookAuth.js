const crypto = require("crypto");

/**
 * Middleware to verify Google Cloud Storage webhook authenticity
 * GCS sends notifications with specific headers that we can verify
 */
const gcsWebhookAuth = (req, res, next) => {
  try {
    // For Object Change Notifications, GCS sends a specific header
    const gcsSignature = req.headers["x-goog-channel-token"];
    const expectedToken = process.env.GCS_WEBHOOK_TOKEN;

    // If we set a webhook token, verify it
    if (expectedToken && gcsSignature !== expectedToken) {
      console.error("❌ GCS Webhook: Invalid token");
      return res.status(401).json({ error: "Unauthorized webhook" });
    }

    // Additional verification: Check if request is from Google's IP ranges
    // (Optional - can be implemented for extra security)

    next();
  } catch (error) {
    console.error("❌ GCS Webhook Auth Error:", error);
    return res.status(500).json({ error: "Webhook authentication failed" });
  }
};

/**
 * Parse metadata from GCS notification
 * GCS sends metadata in the notification payload
 */
const parseGCSMetadata = (notification) => {
  try {
    // GCS Object Change Notification structure
    const metadata = notification.metadata || {};

    return {
      userId: metadata.userId || metadata["x-goog-meta-userid"],
      uploadType: metadata.uploadType || metadata["x-goog-meta-uploadtype"],
      languageName:
        metadata.languageName || metadata["x-goog-meta-languagename"],
      sessionId: metadata.sessionId || metadata["x-goog-meta-sessionid"],
    };
  } catch (error) {
    console.error("❌ Error parsing GCS metadata:", error);
    return {};
  }
};

/**
 * Parse webhook context
 * This helps handle metadata from the storage notifications
 */
const parseWebhookContext = (contextString) => {
  try {
    if (typeof contextString === "string") {
      // Try to parse as JSON
      return JSON.parse(contextString);
    } else if (typeof contextString === "object") {
      return contextString;
    }
    return {};
  } catch (error) {
    // If it's in format "key1=value1|key2=value2"
    const context = {};
    const pairs = contextString.split("|");
    pairs.forEach((pair) => {
      const [key, value] = pair.split("=");
      if (key && value) {
        context[key] = value;
      }
    });
    return context;
  }
};

module.exports = {
  gcsWebhookAuth,
  parseGCSMetadata,
  parseWebhookContext,
};
