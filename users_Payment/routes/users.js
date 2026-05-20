const router = require("express").Router();
const {
  login,
  register,
  verifyEmail,
  viledLogin,
  logout,
  updateLocation,
  Refresh,
} = require("../controllers/authcontroller");

const {
  gcsDocumentWebhook,
  getVerificationStatus,
} = require("../controllers/documentVerificationController");

const {
  verifyToken,
  verifyTokenUpPhoto,
} = require("../middlewares/verifytoken");
const { gcsWebhookAuth } = require("../middlewares/gcsWebhookAuth");

router.post("/register", register);
router.post("/verifyEmail", verifyTokenUpPhoto, verifyEmail);
router.post("/login", login);
router.patch("/updateLocation", verifyToken, updateLocation);
router.post("/viledLogin", verifyTokenUpPhoto, viledLogin);
router.post("/logout", verifyTokenUpPhoto, logout);

// GCS Document Verification Webhook
router.post("/verifyDocuments/webhook", gcsWebhookAuth, gcsDocumentWebhook);

router.get("/verifyDocuments/status", verifyTokenUpPhoto, getVerificationStatus);

// GCS Upload Signature for Document Verification
router.post("/gcs/sign-upload", verifyTokenUpPhoto, async (req, res) => {
  const gcs = require("../config/googleCloudStorage");
  const crypto = require("crypto");

  try {
    const { folder = "documents", userId, uploadType = "document" } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const validDocTypes = ["selfie", "idCard", "guideDocument"];
    if (!validDocTypes.includes(uploadType)) {
      return res.status(400).json({
        error: "Invalid uploadType",
        allowed: validDocTypes,
      });
    }

    const timestamp = Date.now();
    const sessionId = crypto.randomUUID();
    const fileExtension = req.body.fileExtension || "jpg";
    const fileName = `users/${folder}/${uploadType}_${userId}_${timestamp}.${fileExtension}`;

    // Build metadata
    const metadata = {
      userId,
      uploadType,
      sessionId,
    };

    // Determine content type
    let contentType = "image/jpeg";
    if (uploadType === "idCard" || uploadType === "selfie") {
      contentType = "image/jpeg";
    } else if (uploadType === "guideDocument") {
      contentType = "application/pdf"; // or image
    }

    // Generate signed URL
    const signedUrl = await gcs.generateSignedUploadUrl(
      fileName,
      metadata,
      contentType,
      15, // 15 minutes expiry
    );

    res.status(200).json({
      signedUrl,
      fileName,
      uploadType,
      sessionId,
      metadata,
      contentType,
      maxSizeBytes: 10485760, // 10MB
      allowedFormats: "jpg,png,jpeg,webp,pdf",
      expiresIn: 900, // 15 minutes in seconds
      requiredDocuments: {
        selfie: {
          required: true,
          description: "Clear selfie photo with eyes open",
        },
        idCard: { required: true, description: "National ID card or passport" },
        guideDocument: {
          required: false,
          description: "Tour guide certification (optional)",
        },
      },
    });
  } catch (error) {
    console.error("[GCS-SIGN-UPLOAD] Error:", error);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

router.post("/auth/refresh", Refresh);

module.exports = router;
