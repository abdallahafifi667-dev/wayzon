const { subscribe } = require("../config/kafka");
const { getUserModel } = require("../models/users.models");
const { logger } = require("../monitoring/metrics");
const { deleteFile: deleteGCSFile } = require("../config/googleCloudStorage");
// Storage operations are handled in controllers only.

async function initProfileWorker() {
  const User = getUserModel();

  /**
   * Profile Update Event
   * Updates user profile data (phone, description)
   */
  await subscribe("profile-update", async (data) => {
    try {
      const { userId, phone, description, timestamp } = data;

      const updateData = {};
      if (phone) updateData.phone = phone;
      if (description) updateData.description = description;

      const user = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { new: true },
      );

      if (!user) {
        logger.error(`User ${userId} not found`, {
          userId,
          phone,
          description,
          timestamp,
        });
      }
    } catch (error) {
      logger.error(`Error updating profile for user ${data.userId}:`, {
        userId: data.userId,
        error,
      });
    }
  });

  /**
   * GCS Upload Received Event (NEW)
   * Processes uploaded files from Google Cloud Storage
   */
  await subscribe("gcs-upload-received", async (data) => {
    const { logUserAction } = require("../util/auditLogger");

    try {
      const { fileName, fileUrl, userId, uploadType, uploadData } = data;

      // Validate upload
      const errors = [];
      if (uploadData.size > 10485760) errors.push("File too large (max 10MB)");

      const allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "application/pdf",
      ];
      if (!allowedTypes.includes(uploadData.contentType)) {
        errors.push("Invalid file type");
      }

      if (errors.length > 0) {
        logger.error(`Validation failed for ${fileName}:`, errors);
        try {
          await deleteGCSFile(fileName);
        } catch (delErr) {
          logger.error("GCS delete failed:", delErr);
        }

        logUserAction({
          user: userId,
          action: "upload",
          details: {
            action: "gcsUploadWorker",
            status: "validation_failed",
            errors,
            fileName,
          },
        });
        return;
      }

      // Update user
      const user = await User.findById(userId);
      if (!user) {
        logger.error(`User ${userId} not found, cleaning up ${fileName}`);
        try {
          await deleteGCSFile(fileName);
        } catch (delErr) {
          logger.error("GCS delete failed:", delErr);
        }
        return;
      }

      // Update based on upload type
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
          action: "gcsUploadWorker",
          status: "success",
          uploadType,
          fileName,
          url: fileUrl,
        },
      });
    } catch (error) {
      logger.error(`Error processing GCS upload:`, error);

      // Cleanup on error
      if (data.fileName) {
        try {
          await deleteGCSFile(data.fileName);
        } catch (cleanupError) {
          logger.error("GCS cleanup failed:", cleanupError);
        }
      }
    }
  });

  /**
   * GCS Cleanup Event
   * Deletes files from Google Cloud Storage
   */
  await subscribe("gcs-cleanup", async (data) => {
    try {
      const { fileName } = data;
      await deleteGCSFile(fileName);
      logger.info(`GCS file deleted: ${fileName}`);
    } catch (error) {
      logger.error(`Error cleaning up GCS file ${data.fileName}:`, error);
    }
  });

  /**
   * Location Update Event
   * Updates user location coordinates
   */
  await subscribe("location-update", async (data) => {
    try {
      const { userId, location, timestamp } = data;

      const user = await User.findByIdAndUpdate(
        userId,
        { location: location },
        { new: true },
      );

      if (!user) {
        logger.error(`User ${userId} not found`, {
          userId,
          location,
          timestamp,
        });
      }
    } catch (error) {
      logger.error(`Error updating location for user ${data.userId}:`, error);
    }
  });

  /**
   * Document Verification Event
   * Processes KYC verification asynchronously
   */
  await subscribe("document-verification", async (data) => {
    const {
      processDocumentVerification,
    } = require("../controllers/documentVerificationController");
    const { logUserAction } = require("../util/auditLogger");
    const { getUserKYCModel } = require("../models/users.models"); // Import KYC Model

    try {
      const { userId, sessionId, selfieUrl, idCardUrl, guideDocumentUrl } =
        data;
      const UserKYC = getUserKYCModel();

      // Fetch KYC document
      const userKYC = await UserKYC.findOne({ userId });

      if (!userKYC) {
        logger.error(`UserKYC not found for user ${userId}`, {
          userId,
          sessionId,
          selfieUrl,
          idCardUrl,
          guideDocumentUrl,
        });
        return;
      }

      // Verify session matches
      if (userKYC.pendingDocuments?.sessionId !== sessionId) {
        logger.warn(`Session mismatch for user ${userId}`, {
          userId,
          sessionId,
          selfieUrl,
          idCardUrl,
          guideDocumentUrl,
        });
        return;
      }

      // Check if already verified
      if (userKYC.documentation === true) {
        logger.warn(`User ${userId} already verified`, {
          userId,
          sessionId,
          selfieUrl,
          idCardUrl,
          guideDocumentUrl,
        });
        return;
      }

      try {
        // processDocumentVerification now expects UserKYC doc
        await processDocumentVerification(userKYC);

        logUserAction({
          user: userId,
          action: "user",
          details: {
            action: "documentVerificationWorker",
            status: "success",
            sessionId,
          },
        });
      } catch (verifyError) {
        logger.error(
          `Verification failed for user ${userId}:`,
          verifyError.message,
        );

        // Update status to failed
        userKYC.pendingDocuments.verificationStatus = "failed";
        await userKYC.save();

        logUserAction({
          user: userId,
          action: "user",
          details: {
            action: "documentVerificationWorker",
            status: "failed",
            error: verifyError.message,
            sessionId,
          },
        });

        // Cleanup uploaded documents on failure
        const docsToCleanup = [
          userKYC.pendingDocuments?.selfie?.fileName,
          userKYC.pendingDocuments?.idCard?.fileName,
          userKYC.pendingDocuments?.guideDocument?.fileName,
        ].filter(Boolean);

        for (const fileName of docsToCleanup) {
          try {
            await deleteGCSFile(fileName);
          } catch (cleanupError) {
            logger.error(`Cleanup failed for ${fileName}:`, cleanupError);
          }
        }

        // Clear pending documents
        userKYC.pendingDocuments = {
          selfie: { url: null, fileName: null, uploadedAt: null },
          idCard: { url: null, fileName: null, uploadedAt: null },
          guideDocument: { url: null, fileName: null, uploadedAt: null },
          sessionId: null,
          createdAt: null,
          expiresAt: null,
          verificationStatus: "failed",
        };
        await userKYC.save();
      }
    } catch (error) {
      logger.error("Error in document verification worker:", error);
    }
  });
}

// Initialize worker
initProfileWorker().catch((err) => {
  logger.error("Failed to initialize Profile Worker:", err);
  process.exit(1);
});

module.exports = { initProfileWorker };
