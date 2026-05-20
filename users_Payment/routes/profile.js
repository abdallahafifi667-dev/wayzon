var express = require("express");
var router = express.Router();
const {
  verifyToken,
  verifyTokenAndAuthorization,
  verifyTokenUpPhoto,
} = require("../middlewares/verifytoken");
const { gcsWebhookAuth } = require("../middlewares/gcsWebhookAuth");
const {
  getUserProfile,
  updateUserProfile,
  getUserOrderById,
  getUserOrders,
  getTransportation,
  updateTransportation,
} = require("../controllers/profileUser");

router.get("/profile/:id", verifyTokenUpPhoto, getUserProfile);
router.put("/profile/put/:id", verifyTokenAndAuthorization, updateUserProfile);

router.get("/profile/orders/:id", verifyTokenUpPhoto, getUserOrders);
router.get("/profile/order/:id", verifyTokenUpPhoto, getUserOrderById);

// Transportation routes
router.get("/transportation/:id", verifyTokenUpPhoto, getTransportation);
router.put(
  "/transportation/:id",
  verifyTokenAndAuthorization,
  updateTransportation,
);

// GCS Upload Signature Endpoint
router.post("/gcs/sign-upload", verifyToken, async (req, res) => {
  const gcs = require("../config/googleCloudStorage");

  try {
    const {
      folder = "avatars",
      userId,
      uploadType = "avatar",
      languageName,
    } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // Build file path
    const timestamp = Date.now();
    const fileExtension = req.body.fileExtension || "jpg"; // Client should provide this
    const fileName = `users/${folder}/${userId}_${timestamp}.${fileExtension}`;

    // Build metadata
    const metadata = { userId, uploadType };
    if (uploadType === "language-video" && languageName) {
      metadata.languageName = languageName;
    }

    // Determine content type and limits
    let contentType = "image/jpeg";
    let maxSizeBytes = 10485760; // 10MB
    let allowedFormats = "jpg,png,jpeg,webp,pdf";

    if (uploadType === "language-video") {
      contentType = "video/mp4";
      maxSizeBytes = 52428800; // 50MB
      allowedFormats = "mp4,webm,avi,mov,mkv";
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
      metadata,
      contentType,
      maxSizeBytes,
      allowedFormats,
      expiresIn: 900, // 15 minutes in seconds
    });
  } catch (error) {
    console.error("GCS sign-upload error:", error);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// GCS Webhook Handler
const { handleGCSWebhook } = require("../controllers/gcsWebhook");
router.post("/gcs/webhook", gcsWebhookAuth, handleGCSWebhook);

module.exports = router;
