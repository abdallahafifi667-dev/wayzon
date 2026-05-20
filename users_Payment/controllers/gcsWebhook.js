const asyncHandler = require("express-async-handler");
const { getUserModel } = require("../models/users.models");
const { parseGCSMetadata } = require("../middlewares/gcsWebhookAuth");
const { deleteFile, getFileMetadata } = require("../config/googleCloudStorage");
const { logger } = require("../monitoring/metrics");
const { logUserAction } = require("../util/auditLogger");
const { sendEvent } = require("../config/kafka");

const User = getUserModel();

/**
 * @desc    Handle GCS webhook for profile uploads (avatars, general files)
 * @route   POST /api/user/gcs/webhook
 * @access  Public (with GCS webhook authentication)
 */
exports.handleGCSWebhook = asyncHandler(async (req, res) => {
  try {
    // GCS Object Change Notification structure
    const notification = req.body;

    // Extract file information
    const fileName = notification.name; // e.g., "users/avatars/userId_timestamp.jpg"
    const bucketName = notification.bucket;
    const eventType = notification.eventType || notification.kind; // e.g., "OBJECT_FINALIZE"

    // Only process finalize events (upload complete)
    if (eventType !== "OBJECT_FINALIZE" && eventType !== "storage#object") {
      return res
        .status(200)
        .json({ status: "ignored", reason: "not_finalize_event" });
    }

    // Parse metadata
    const metadata = parseGCSMetadata(notification);
    const { userId, uploadType } = metadata;

    if (!userId || !uploadType) {
      logger.warn("[GCS_WEBHOOK] Missing metadata, cleaning up file", {
        fileName,
      });
      try {
        await deleteFile(fileName);
      } catch (cleanupErr) {
        logger.error("[GCS_WEBHOOK] Cleanup failed:", cleanupErr);
      }
      return res
        .status(200)
        .json({ status: "ignored", reason: "missing_metadata" });
    }

    // Validate upload type
    const validTypes = ["avatar", "document"];
    if (!validTypes.includes(uploadType)) {
      logger.warn("[GCS_WEBHOOK] Invalid upload type", {
        fileName,
        uploadType,
      });
      try {
        await deleteFile(fileName);
      } catch (cleanupErr) {
        logger.error("[GCS_WEBHOOK] Cleanup failed:", cleanupErr);
      }
      return res
        .status(200)
        .json({ status: "ignored", reason: "invalid_upload_type" });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      logger.error("[GCS_WEBHOOK] User not found, cleaning up", {
        userId,
        fileName,
      });
      try {
        await deleteFile(fileName);
      } catch (cleanupErr) {
        logger.error("[GCS_WEBHOOK] Cleanup failed:", cleanupErr);
      }
      return res
        .status(200)
        .json({ status: "ignored", reason: "user_not_found" });
    }

    // Generate public URL for the file
    const fileUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

    // Send to Kafka for async processing (with validation)
    try {
      await sendEvent("gcs-upload-received", {
        fileName,
        fileUrl,
        userId,
        uploadType,
        uploadData: {
          size: notification.size,
          contentType: notification.contentType,
          timeCreated: notification.timeCreated,
          updated: notification.updated,
        },
      });

      logUserAction({
        user: userId,
        action: "upload",
        details: {
          action: "gcsWebhook",
          status: "queued",
          uploadType,
          fileName,
        },
      });

      res.status(200).json({
        status: "accepted",
        message: "Upload queued for processing",
      });
    } catch (kafkaError) {
      logger.error(
        "[GCS_WEBHOOK] Kafka failed, using sync fallback:",
        kafkaError,
      );

      // Sync fallback: Update user directly
      if (uploadType === "avatar") {
        user.avatar = fileUrl;
        user.PersonalPhoto = [fileUrl];
      } else if (uploadType === "document") {
        user.documentPhoto = fileUrl;
      }

      await user.save();

      logUserAction({
        user: userId,
        action: "upload",
        details: {
          action: "gcsWebhook",
          status: "success_sync",
          uploadType,
          fileName,
        },
      });

      res.status(200).json({
        status: "success",
        message: "Upload processed successfully",
      });
    }
  } catch (error) {
    logger.error("[GCS_WEBHOOK] Error:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});
