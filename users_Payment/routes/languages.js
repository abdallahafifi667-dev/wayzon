var express = require("express");
var router = express.Router();
const { verifyToken } = require("../middlewares/verifytoken");
const { gcsWebhookAuth } = require("../middlewares/gcsWebhookAuth");
const {
  addLanguage,
  getLanguages,
  updateLanguage,
  deleteLanguage,
  handleLanguageVideoWebhook,
} = require("../controllers/languageController");

/**
 * GET /api/user/languages - Get all languages for authenticated user
 */
router.get("/", verifyToken, getLanguages);

/**
 * POST /api/user/languages - Add a new language
 * Body: { name: string, proficiency: "beginner"|"intermediate"|"advanced"|"native" }
 */
router.post("/", verifyToken, addLanguage);

/**
 * PUT /api/user/languages/:languageName - Update language proficiency and/or video
 * Body: { proficiency?: string, video?: string }
 */
router.put("/:languageName", verifyToken, updateLanguage);

/**
 * DELETE /api/user/languages/:languageName - Delete a language
 */
router.delete("/:languageName", verifyToken, deleteLanguage);

/**
 * POST /api/user/languages/webhook/video - GCS webhook for language video uploads
 * Public endpoint but protected with GCS signature verification
 */
router.post("/webhook/video", gcsWebhookAuth, handleLanguageVideoWebhook);

module.exports = router;
