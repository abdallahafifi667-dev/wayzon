const asyncHandler = require("express-async-handler");
const xss = require("xss");
const { getUserModel } = require("../models/users.models");
const { logUserAction } = require("../util/auditLogger");
const { parseGCSMetadata } = require("../middlewares/gcsWebhookAuth");
const { deleteFile } = require("../config/googleCloudStorage");
const { logger } = require("../monitoring/metrics");

const User = getUserModel();

/**
 * @desc    Add a new language to user's languages
 * @route   POST /api/user/languages
 * @access  Private
 */
exports.addLanguage = asyncHandler(async (req, res) => {
  try {
    const { name, proficiency } = req.body;
    const userId = req.user._id;

    // Validate required fields
    if (!name || !proficiency) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "addLanguage",
          error: "Missing required fields: name, proficiency",
        },
      });
      return res
        .status(400)
        .json({ message: "Language name and proficiency level are required" });
    }

    // Validate proficiency level
    const validProficiencies = [
      "beginner",
      "intermediate",
      "advanced",
      "native",
    ];
    if (!validProficiencies.includes(proficiency)) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "addLanguage",
          error: "Invalid proficiency level",
        },
      });
      return res.status(400).json({
        message: `Invalid proficiency level. Must be one of: ${validProficiencies.join(", ")}`,
      });
    }

    // Check if user exists and email is verified
    const user = await User.findById(userId);
    if (!user) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "addLanguage",
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.email.verified) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "addLanguage",
          error: "Email not verified",
        },
      });
      return res.status(403).json({
        message: "Email must be verified before adding languages",
      });
    }

    // Check if language already exists (case-insensitive)
    const languageExists = user.languages.some(
      (lang) => lang.name.toLowerCase() === name.toLowerCase(),
    );

    if (languageExists) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "addLanguage",
          language: name,
          error: "Language already exists for this user",
        },
      });
      return res.status(409).json({
        message: `Language "${name}" already exists in your profile`,
      });
    }

    // Add new language
    const newLanguage = {
      name: xss(name),
      proficiency: proficiency,
      video: null, // Will be updated when webhook returns video ID
    };

    user.languages.push(newLanguage);
    await user.save();

    logUserAction({
      user: userId,
      ip: req.ip,
      action: "user",
      details: {
        action: "addLanguage",
        language: name,
        proficiency: proficiency,
      },
    });

    res.status(201).json({
      message: "Language added successfully",
      language: newLanguage,
      languages: user.languages,
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "addLanguage",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Error adding language", error: error.message });
  }
});

/**
 * @desc    Get all languages for user
 * @route   GET /api/user/languages
 * @access  Private
 */
exports.getLanguages = asyncHandler(async (req, res) => {
  try {
    const userId = req.user._id;

    const user = await User.findById(userId).select("languages");

    if (!user) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "getLanguages",
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    logUserAction({
      user: userId,
      ip: req.ip,
      action: "user",
      details: {
        action: "getLanguages",
        languageCount: user.languages.length,
      },
    });

    res.status(200).json({
      languages: user.languages,
      count: user.languages.length,
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "getLanguages",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Error fetching languages", error: error.message });
  }
});

/**
 * @desc    Update language proficiency and/or video
 * @route   PUT /api/user/languages/:languageName
 * @access  Private
 */
exports.updateLanguage = asyncHandler(async (req, res) => {
  try {
    const { languageName } = req.params;
    const { proficiency, video } = req.body;
    const userId = req.user._id;

    const user = await User.findById(userId);

    if (!user) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateLanguage",
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    // Find language
    const language = user.languages.find(
      (lang) => lang.name.toLowerCase() === languageName.toLowerCase(),
    );

    if (!language) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "updateLanguage",
          language: languageName,
          error: "Language not found",
        },
      });
      return res.status(404).json({
        message: `Language "${languageName}" not found in your profile`,
      });
    }

    // Update proficiency if provided
    if (proficiency) {
      const validProficiencies = [
        "beginner",
        "intermediate",
        "advanced",
        "native",
      ];
      if (!validProficiencies.includes(proficiency)) {
        return res.status(400).json({
          message: `Invalid proficiency level. Must be one of: ${validProficiencies.join(", ")}`,
        });
      }
      language.proficiency = proficiency;
    }

    // Update video if provided (from webhook)
    if (video) {
      language.video = video;
    }

    await user.save();

    logUserAction({
      user: userId,
      ip: req.ip,
      action: "user",
      details: {
        action: "updateLanguage",
        language: languageName,
        proficiency: language.proficiency,
        hasVideo: !!language.video,
      },
    });

    res.status(200).json({
      message: "Language updated successfully",
      language: language,
      languages: user.languages,
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "updateLanguage",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Error updating language", error: error.message });
  }
});

/**
 * @desc    Delete a language
 * @route   DELETE /api/user/languages/:languageName
 * @access  Private
 */
exports.deleteLanguage = asyncHandler(async (req, res) => {
  try {
    const { languageName } = req.params;
    const userId = req.user._id;

    const user = await User.findById(userId);

    if (!user) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "deleteLanguage",
          error: "User not found",
        },
      });
      return res.status(404).json({ message: "User not found" });
    }

    // Find and remove language
    const initialLength = user.languages.length;
    user.languages = user.languages.filter(
      (lang) => lang.name.toLowerCase() !== languageName.toLowerCase(),
    );

    if (user.languages.length === initialLength) {
      logUserAction({
        user: userId,
        ip: req.ip,
        action: "user",
        details: {
          action: "deleteLanguage",
          language: languageName,
          error: "Language not found",
        },
      });
      return res.status(404).json({
        message: `Language "${languageName}" not found in your profile`,
      });
    }

    await user.save();

    logUserAction({
      user: userId,
      ip: req.ip,
      action: "user",
      details: {
        action: "deleteLanguage",
        language: languageName,
      },
    });

    res.status(200).json({
      message: "Language deleted successfully",
      languages: user.languages,
    });
  } catch (error) {
    logUserAction({
      user: req.user?._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "deleteLanguage",
        error: error.message,
      },
    });
    res
      .status(500)
      .json({ message: "Error deleting language", error: error.message });
  }
});

/**
 * @desc    Handle language video upload webhook from GCS
 * @route   POST /api/user/languages/webhook/video
 * @access  Public (with signature verification)
 */
exports.handleLanguageVideoWebhook = asyncHandler(async (req, res) => {
  try {
    // ✅ Signature verification already done by gcsWebhookAuth middleware

    // GCS Object Change Notification structure
    const notification = req.body;
    const fileName = notification.name;
    const eventType = notification.eventType || notification.kind;

    // Only process finalize events
    if (eventType !== "OBJECT_FINALIZE" && eventType !== "storage#object") {
      return res.status(200).json({ status: "ignored" });
    }

    const metadata = parseGCSMetadata(notification);
    const userId = metadata.userId;
    const languageName = metadata.languageName;

    if (!userId || !languageName) {
      // Cleanup invalid upload
      try {
        await deleteFile(fileName);
      } catch (e) {
        console.error("Failed to cleanup invalid language video:", e);
      }
      return res.status(200).json({ status: "ignored_missing_context" });
    }

    // Find user and update language video
    const user = await User.findById(userId);

    if (!user) {
      try {
        await deleteFile(fileName);
      } catch (e) {
        console.error("Failed to cleanup video for non-existent user:", e);
      }
      return res.status(200).json({ status: "ignored_user_not_found" });
    }

    // Find and update language
    const language = user.languages.find(
      (lang) => lang.name.toLowerCase() === languageName.toLowerCase(),
    );

    if (!language) {
      try {
        await deleteFile(fileName);
      } catch (e) {
        console.error("Failed to cleanup video for non-existent language:", e);
      }
      return res.status(200).json({ status: "ignored_language_not_found" });
    }

    // Validate video (only video files)
    const allowedFormats = ["mp4", "webm", "avi", "mov", "mkv"];
    const contentType = notification.contentType || "";
    const isVideo = contentType.startsWith("video/");

    if (!isVideo) {
      try {
        await deleteFile(fileName);
      } catch (e) {
        console.error("Failed to cleanup invalid video format:", e);
      }
      return res.status(200).json({ status: "invalid_video_format" });
    }

    // Generate public URL
    const fileUrl = `https://storage.googleapis.com/${notification.bucket}/${fileName}`;

    // Update language with video URL
    language.video = fileUrl;
    await user.save();

    logUserAction({
      user: userId,
      ip: req.ip,
      action: "user",
      details: {
        action: "languageVideoUploaded",
        language: languageName,
        videoUrl: fileUrl,
        fileName: fileName,
      },
    });

    res.status(200).json({
      status: "success",
      message: "Language video updated successfully",
      language: language,
    });
  } catch (error) {
    logUserAction({
      user: req.body?.metadata?.userId,
      ip: req.ip,
      action: "user",
      details: {
        action: "languageVideoWebhook",
        error: error.message,
      },
    });
    res.status(500).json({
      status: "error",
      message: "Error processing language video webhook",
      error: error.message,
    });
  }
});
