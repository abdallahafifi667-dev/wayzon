/**
 * Flexible Response Service - خدمة الردود المرنة
 *
 * يدعم أنواع مختلفة من الأسئلة والردود:
 * - YES_NO: سؤال بسيط نعم/لا
 * - CHOICES: خيارات متعددة
 * - TEXT: رد نصي حر
 * - LOCATION: طلب الموقع الحالي
 * - PHOTO: طلب صورة كدليل
 * - RATING: تقييم من 1-5
 */

const { logger } = require("../monitoring/metrics");
const tripStateManager = require("./tripStateManager");
const timerManager = require("./timerManager");
const NotificationService = require("../controllers/Notification/notificationService");
const { getUserModel } = require("../models/users.models");
const { getIo, userSocketMap } = require("../socket");
const escalationService = require("./safety/escalationService");
const dataCollector = require("./safety/dataCollector");
const aiAnalyzer = require("./safety/aiAnalyzer");

// Question types
const QUESTION_TYPES = {
  YES_NO: "yes_no",
  CHOICES: "choices",
  TEXT: "text",
  LOCATION: "location",
  PHOTO: "photo",
  RATING: "rating",
  MULTI_CHOICE: "multi_choice",
};

// Default timeouts per question type
const DEFAULT_TIMEOUTS = {
  [QUESTION_TYPES.YES_NO]: 60, // 1 minute
  [QUESTION_TYPES.CHOICES]: 90, // 1.5 minutes
  [QUESTION_TYPES.TEXT]: 120, // 2 minutes
  [QUESTION_TYPES.LOCATION]: 45, // 45 seconds
  [QUESTION_TYPES.PHOTO]: 180, // 3 minutes
  [QUESTION_TYPES.RATING]: 60, // 1 minute
  [QUESTION_TYPES.MULTI_CHOICE]: 90, // 1.5 minutes
};

// Response validators per type
const VALIDATORS = {
  [QUESTION_TYPES.YES_NO]: (response) => {
    const normalized = String(response).toLowerCase().trim();
    const yesValues = ["yes", "نعم", "true", "1", "ok", "okay", "اه", "ايوه"];
    const noValues = ["no", "لا", "false", "0", "لأ"];

    if (yesValues.includes(normalized))
      return { valid: true, normalized: true };
    if (noValues.includes(normalized))
      return { valid: true, normalized: false };
    return { valid: false, error: "Please answer yes or no" };
  },

  [QUESTION_TYPES.CHOICES]: (response, question) => {
    const validIds = question.options.map((o) => o.id);
    if (validIds.includes(response)) {
      return { valid: true, normalized: response };
    }
    // Check by label
    const byLabel = question.options.find(
      (o) => o.label.toLowerCase() === String(response).toLowerCase(),
    );
    if (byLabel) {
      return { valid: true, normalized: byLabel.id };
    }
    return {
      valid: false,
      error: `Please select one of: ${validIds.join(", ")}`,
    };
  },

  [QUESTION_TYPES.TEXT]: (response, question) => {
    const text = String(response).trim();
    if (!text && question.required) {
      return { valid: false, error: "Text response required" };
    }
    if (question.maxLength && text.length > question.maxLength) {
      return {
        valid: false,
        error: `Maximum ${question.maxLength} characters`,
      };
    }
    if (question.minLength && text.length < question.minLength) {
      return {
        valid: false,
        error: `Minimum ${question.minLength} characters`,
      };
    }
    return { valid: true, normalized: text };
  },

  [QUESTION_TYPES.LOCATION]: (response) => {
    if (Array.isArray(response) && response.length === 2) {
      const [lng, lat] = response;
      if (typeof lng === "number" && typeof lat === "number") {
        if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
          return { valid: true, normalized: response };
        }
      }
    }
    if (response?.coordinates) {
      return VALIDATORS[QUESTION_TYPES.LOCATION](response.coordinates);
    }
    return { valid: false, error: "Invalid location format" };
  },

  [QUESTION_TYPES.PHOTO]: (response) => {
    // Check for base64 or URL
    if (typeof response === "string") {
      if (
        response.startsWith("data:image/") ||
        response.startsWith("http://") ||
        response.startsWith("https://")
      ) {
        return { valid: true, normalized: response };
      }
    }
    if (response?.url || response?.base64) {
      return { valid: true, normalized: response.url || response.base64 };
    }
    return { valid: false, error: "Please provide an image" };
  },

  [QUESTION_TYPES.RATING]: (response) => {
    const rating = parseInt(response);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      return { valid: false, error: "Rating must be 1-5" };
    }
    return { valid: true, normalized: rating };
  },

  [QUESTION_TYPES.MULTI_CHOICE]: (response, question) => {
    const validIds = question.options.map((o) => o.id);
    let selections = Array.isArray(response) ? response : [response];

    const normalized = [];
    for (const sel of selections) {
      if (validIds.includes(sel)) {
        normalized.push(sel);
      } else {
        const byLabel = question.options.find(
          (o) => o.label.toLowerCase() === String(sel).toLowerCase(),
        );
        if (byLabel) normalized.push(byLabel.id);
      }
    }

    if (normalized.length === 0 && question.required) {
      return { valid: false, error: "Please select at least one option" };
    }
    return { valid: true, normalized };
  },
};

/**
 * Create and send a flexible question
 * @param {string} tripId - Trip ID
 * @param {string} userId - Target user ID
 * @param {Object} questionConfig - Question configuration
 * @returns {Object} Question instance
 */
async function sendQuestion(tripId, userId, questionConfig) {
  const User = getUserModel();
  const io = getIo();

  const question = {
    id: `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    tripId,
    targetUserId: userId.toString(),
    type: questionConfig.type || QUESTION_TYPES.YES_NO,
    question: questionConfig.question,
    questionAr: questionConfig.questionAr,
    options: questionConfig.options || null,
    required: questionConfig.required !== false,
    timeout:
      questionConfig.timeout || DEFAULT_TIMEOUTS[questionConfig.type] || 60,
    priority: questionConfig.priority || "normal",
    context: questionConfig.context || {},
    sentAt: Date.now(),
    followUp: questionConfig.followUp || null, // Next question if this one answered
    maxLength: questionConfig.maxLength,
    minLength: questionConfig.minLength,
  };

  // Store pending question
  await tripStateManager.setPendingResponse(tripId, question.type, userId, {
    questionId: question.id,
    fullQuestion: question,
  });

  // Send via socket
  const socketId = userSocketMap?.get(userId?.toString());
  if (socketId) {
    io.to(socketId).emit("safety_question", {
      ...question,
      ui: getUIHints(question),
    });
  }

  // Send FCM for high priority
  if (question.priority === "high" || question.priority === "urgent") {
    const user = await User.findById(userId).select("fcmTokens").lean();
    if (user?.fcmTokens?.length) {
      await NotificationService.sendToMultipleDevices(
        user.fcmTokens,
        question.priority === "urgent"
          ? "⚠️ Urgent Safety Question"
          : "🔔 Safety Question",
        question.question,
        { tripId, type: "safety_question", questionId: question.id },
      );
    }
  }

  // Schedule timeout
  timerManager.schedule(
    tripId,
    async () => {
      const state = await tripStateManager.getTripState(tripId);
      if (state?.pendingResponse?.questionId === question.id) {
        await handleTimeout(tripId, question);
      }
    },
    question.timeout * 1000,
    `question_timeout_${question.id}`,
  );

  logger.info("Question sent", {
    tripId,
    questionId: question.id,
    type: question.type,
    userId: userId.toString(),
  });

  return question;
}

/**
 * Handle a manual "I am okay" check-in from the user
 * Acts as a proactive signal of safety without needing a pending question.
 */
async function processManualCheckIn(tripId, userId) {
  const state = await tripStateManager.getOrCreateTripState(tripId);

  // Record the check-in
  const checkInRecord = {
    type: "manual_checkin",
    respondedAt: Date.now(),
    ip: "proactive_signal",
  };

  state.responseHistory = state.responseHistory || [];
  state.responseHistory.push(checkInRecord);

  // Clear any low-priority pending alerts
  if (state.pendingResponse && state.pendingResponse.priority !== "urgent") {
    await tripStateManager.clearPendingResponse(tripId);
  }

  await tripStateManager.setTripState(tripId, state);
  logger.info("Manual check-in received", { tripId, userId });

  return { status: "received", timestamp: checkInRecord.respondedAt };
}

/**
 * Get UI rendering hints for question type
 */
function getUIHints(question) {
  const hints = {
    inputType: "button",
    layout: "vertical",
    showTimer: true,
    canDismiss: false,
  };

  switch (question.type) {
    case QUESTION_TYPES.YES_NO:
      hints.inputType = "buttons";
      hints.buttons = [
        { id: "yes", label: "نعم", labelEn: "Yes", color: "success" },
        { id: "no", label: "لا", labelEn: "No", color: "danger" },
      ];
      break;

    case QUESTION_TYPES.CHOICES:
      hints.inputType = "single_select";
      hints.layout = question.options?.length > 4 ? "list" : "grid";
      break;

    case QUESTION_TYPES.MULTI_CHOICE:
      hints.inputType = "multi_select";
      hints.layout = "list";
      hints.showConfirm = true;
      break;

    case QUESTION_TYPES.TEXT:
      hints.inputType = "textarea";
      hints.maxLength = question.maxLength || 500;
      hints.placeholder = "Type your response here...";
      break;

    case QUESTION_TYPES.LOCATION:
      hints.inputType = "location_picker";
      hints.showMap = true;
      hints.autoDetect = true;
      break;

    case QUESTION_TYPES.PHOTO:
      hints.inputType = "camera";
      hints.allowGallery = false; // For safety, camera only
      hints.maxSize = 5 * 1024 * 1024; // 5MB
      break;

    case QUESTION_TYPES.RATING:
      hints.inputType = "stars";
      hints.max = 5;
      break;
  }

  return hints;
}

/**
 * Process user response to a question
 * @param {string} tripId - Trip ID
 * @param {string} userId - User responding
 * @param {any} response - User's response
 * @returns {Object} Validation result and next action
 */
async function processResponse(tripId, userId, response) {
  const state = await tripStateManager.getTripState(tripId);

  if (!state?.pendingResponse) {
    return { status: "no_pending_question" };
  }

  const question = state.pendingResponse.fullQuestion;
  if (!question) {
    return { status: "question_not_found" };
  }

  // Validate response
  const validator = VALIDATORS[question.type];
  if (!validator) {
    return { status: "unknown_question_type" };
  }

  const validation = validator(response, question);

  if (!validation.valid) {
    // Don't clear pending, let user retry
    const io = getIo();
    const socketId = userSocketMap?.get(userId?.toString());
    if (socketId) {
      io.to(socketId).emit("response_validation_error", {
        tripId,
        questionId: question.id,
        error: validation.error,
        canRetry: true,
      });
    }

    return {
      status: "validation_failed",
      error: validation.error,
      canRetry: true,
    };
  }

  // Clear pending response
  await tripStateManager.clearPendingResponse(tripId);

  // Record response
  const responseRecord = {
    questionId: question.id,
    type: question.type,
    response: validation.normalized,
    rawResponse: response,
    respondedAt: Date.now(),
    responseTimeMs: Date.now() - question.sentAt,
  };

  // Update response history
  state.responseHistory = state.responseHistory || [];
  state.responseHistory.push(responseRecord);
  await tripStateManager.setTripState(tripId, state);

  // Phase 8: Consolidated Logic - Record response in escalation service & data collector
  try {
    await escalationService.recordUserResponse(
      tripId,
      userId,
      responseRecord.response,
      responseRecord.responseTimeMs,
    );

    // Link to ML event if exists in state or context
    const eventId = state.lastEventId || question.context?.eventId;
    if (eventId) {
      await dataCollector.recordUserResponse(eventId, {
        questionId: question.id,
        type: question.type,
        answer:
          typeof responseRecord.response === "object"
            ? responseRecord.response.label || responseRecord.response.id
            : responseRecord.response,
        responseTime: responseRecord.responseTimeMs,
      });
    }
  } catch (err) {
    logger.error("Failed to record unified response details", {
      tripId,
      error: err.message,
    });
  }

  // Phase 8: Auto-escalate if help requested
  const helpKeywords = [
    "need_help",
    "help",
    "lost",
    "problem",
    "unsafe",
    "danger",
  ];
  const respondedId =
    typeof responseRecord.response === "object"
      ? responseRecord.response.id
      : String(responseRecord.response).toLowerCase();

  if (helpKeywords.includes(respondedId)) {
    try {
      const Order = require("../models/order.models").getOrderModel();
      const tripDetails = await Order.findById(tripId).lean();

      await escalationService.escalateToAdmin(tripId, {
        coordinates: state.lastTouristLocation || state.lastGuideLocation,
        role:
          userId.toString() === tripDetails?.guide?.toString()
            ? "guide"
            : "tourist",
        reason: `User responded with emergency flag: ${respondedId}`,
        tripDetails,
        responseHistory: state.responseHistory,
      });

      return {
        status: "escalated",
        response: validation.normalized,
        reason: "user_requested_help",
      };
    } catch (err) {
      logger.error("Failed to escalate emergency response", {
        tripId,
        error: err.message,
      });
    }
  }

  // Phase 18: AI-Powered Follow-up Analysis
  if (
    question.type === QUESTION_TYPES.TEXT ||
    respondedId === "problem" ||
    respondedId === "no"
  ) {
    try {
      const followUpAnalysis = await aiAnalyzer.generateFollowUpQuestion(
        validation.normalized,
        {
          tripId,
          questionType: question.type,
          originalQuestion: question.question,
        },
      );

      if (followUpAnalysis.needsFollowUp && followUpAnalysis.followUpQuestion) {
        const followUpQuestion = await sendQuestion(tripId, userId, {
          type: QUESTION_TYPES.TEXT,
          question: followUpAnalysis.followUpQuestion,
          priority: followUpAnalysis.shouldEscalate ? "high" : "normal",
          context: { aiFollowUp: true },
        });

        return {
          status: "answered",
          response: validation.normalized,
          followUpSent: true,
          aiAnalysis: followUpAnalysis,
        };
      }

      if (followUpAnalysis.shouldEscalate) {
        await escalationService.escalateToAdmin(tripId, {
          reason: `AI Follow-up Escalation: ${followUpAnalysis.assessment}`,
          userResponse: validation.normalized,
          tripId,
        });
      } else if (respondedId === "ok" || respondedId === "yes") {
        // Phase 19: Auto-resolve pending alert if user confirms safety
        const state = await tripStateManager.getTripState(tripId);
        if (state?.lastEmergencyAlertId) {
          await escalationService.updateAlertStatus(
            state.lastEmergencyAlertId,
            "resolved",
            {
              resolvedVia: "user_safety_confirmation",
              response: validation.normalized,
            },
          );
          logger.info("Emergency alert auto-resolved via user confirmation", {
            tripId,
            alertId: state.lastEmergencyAlertId,
          });
        }
      }
    } catch (err) {
      logger.debug("AI Follow-up analysis skipped or failed", {
        error: err.message,
      });
    }
  }

  // Phase 23: Connect back to specialized handlers for state updates
  if (question.id === "distance_check") {
    const distanceMonitor = require("./safety/distanceMonitor");
    await distanceMonitor.handleDistanceResponse(tripId, userId, {
      intentional:
        respondedId === "yes" ||
        respondedId === "intentional" ||
        respondedId === "ok",
      needsHelp: respondedId === "no" || respondedId === "need_help",
      reason:
        typeof responseRecord.response === "string"
          ? responseRecord.response
          : respondedId,
    });
  }

  return {
    status: "answered",
    response: validation.normalized,
    responseTimeMs: responseRecord.responseTimeMs,
  };
}

/**
 * Handle question timeout
 */
async function handleTimeout(tripId, question) {
  await tripStateManager.clearPendingResponse(tripId);

  const state = (await tripStateManager.getTripState(tripId)) || {};
  state.responseHistory = state.responseHistory || [];
  state.responseHistory.push({
    questionId: question.id,
    type: question.type,
    response: null,
    timedOut: true,
    sentAt: question.sentAt,
    timedOutAt: Date.now(),
  });
  await tripStateManager.setTripState(tripId, state);

  logger.warn("Question timed out", {
    tripId,
    questionId: question.id,
    type: question.type,
  });

  // Phase 8: Unified Escalation Logic - Handle timeout based on current level
  try {
    const Order = require("../models/order.models").getOrderModel();
    const tripDetails = await Order.findById(tripId).lean();
    const escalationLevel = state.escalationLevel || 0;
    const plan = tripDetails?.safetyConfig?.plan || "free";

    if (plan === "free") {
      logger.info(
        "Skipping timeout escalation for free plan (Silent Guardian)",
        { tripId, questionId: question.id },
      );
      return { status: "timeout_ignored", plan: "free" };
    }

    if (escalationLevel < escalationService.ESCALATION_LEVELS.SECOND_WARNING) {
      // Send second warning
      await sendSecondWarningInternal(tripId, tripDetails, question);
    } else {
      // Final escalation to admin
      await escalationService.escalateToAdmin(tripId, {
        coordinates: state.lastTouristLocation || state.lastGuideLocation,
        role:
          question.targetUserId.toString() === tripDetails?.guide?.toString()
            ? "guide"
            : "tourist",
        reason: "no_response_to_multiple_safety_checks",
        tripDetails,
        responseHistory: state.responseHistory,
      });
    }
  } catch (err) {
    logger.error("Failed to handle timeout escalation", {
      tripId,
      error: err.message,
    });
  }

  return { status: "timeout", questionId: question.id };
}

/**
 * Internal helper for second warning (Migrated from orchestrator)
 */
async function sendSecondWarningInternal(
  tripId,
  tripDetails,
  originalQuestion,
) {
  const targetUserId = originalQuestion.targetUserId;
  const io = getIo();
  const User = getUserModel();
  const user = await User.findById(targetUserId).select("fcmTokens").lean();

  const message =
    "⚠️ URGENT: Please respond to confirm your safety. We are monitoring your trip.";

  // 1. Emit socket
  const socketId = userSocketMap?.get(targetUserId.toString());
  if (socketId) {
    io.to(socketId).emit("urgent_safety_check", { tripId, message });
  }

  // 2. Send FCM
  if (user?.fcmTokens?.length) {
    await NotificationService.sendToMultipleDevices(
      user.fcmTokens,
      "⚠️ Urgent Safety Check",
      message,
      {
        tripId,
        type: "urgent_safety_check",
        originalQuestionId: originalQuestion.id,
      },
    );
  }

  // 3. Update level
  await tripStateManager.setEscalationLevel(
    tripId,
    escalationService.ESCALATION_LEVELS.SECOND_WARNING,
  );

  // 4. Schedule final urgent timeout (shorter)
  const urgentTimeout = 60; // 1 minute for urgent response
  timerManager.schedule(
    tripId,
    async () => {
      const state = await tripStateManager.getTripState(tripId);
      // If still no response to anything, trigger handleTimeout again at the NEW level
      if (!state?.pendingResponse) {
        // Since we cleared it, we check if it's still clear
        await handleTimeout(tripId, {
          ...originalQuestion,
          timeout: urgentTimeout,
          sentAt: Date.now(),
        });
      }
    },
    urgentTimeout * 1000,
    `urgent_timeout_${originalQuestion.id}`,
  );
}

/**
 * Cancel a pending question
 */
async function cancelQuestion(tripId, questionId) {
  const state = await tripStateManager.getTripState(tripId);

  if (state?.pendingResponse?.questionId === questionId) {
    await tripStateManager.clearPendingResponse(tripId);

    // Notify user
    const io = getIo();
    const socketId = userSocketMap?.get(
      state.pendingResponse.sentTo?.toString(),
    );
    if (socketId) {
      io.to(socketId).emit("question_cancelled", { tripId, questionId });
    }

    return { status: "cancelled" };
  }

  return { status: "not_found" };
}

/**
 * Get question templates for common scenarios
 */
function getQuestionTemplate(templateId, context = {}) {
  const templates = {
    route_deviation: {
      type: QUESTION_TYPES.CHOICES,
      question: "You seem to be off the planned route. Is this intentional?",
      options: [
        { id: "exploring", label: "Yes, we're exploring" },
        { id: "shortcut", label: "Yes, taking a different route" },
        { id: "lost", label: "No, I'm not sure where we are" },
        { id: "problem", label: "No, there's a problem" },
      ],
      followUp: {
        conditions: [
          {
            when: "lost",
            then: {
              type: QUESTION_TYPES.YES_NO,
              question: "Do you need help?",
            },
          },
          {
            when: "problem",
            then: {
              type: QUESTION_TYPES.TEXT,
              question: "What's the problem?",
              priority: "high",
            },
          },
        ],
      },
      timeout: 90,
      priority: "normal",
    },

    extended_stop: {
      type: QUESTION_TYPES.CHOICES,
      question: "We noticed an extended stop. Is everything okay?",
      options: [
        { id: "eating", label: "Having a meal" },
        { id: "sightseeing", label: "Visiting a tourist spot" },
        { id: "resting", label: "Taking a break" },
        { id: "problem", label: "There's a problem" },
      ],
      timeout: 120,
      priority: "normal",
    },

    sos_confirm: {
      type: QUESTION_TYPES.YES_NO,
      question: "Do you need emergency assistance?",
      timeout: 30,
      priority: "urgent",
    },

    location_verify: {
      type: QUESTION_TYPES.LOCATION,
      question: "Please share your current location to verify your safety.",
      timeout: 45,
      priority: "high",
    },

    photo_verify: {
      type: QUESTION_TYPES.PHOTO,
      question: "Please send a photo of your current location.",
      timeout: 180,
      priority: "high",
    },
  };

  return templates[templateId] || null;
}

module.exports = {
  sendQuestion,
  processResponse,
  processManualCheckIn,
  cancelQuestion,
  getQuestionTemplate,
  QUESTION_TYPES,
  DEFAULT_TIMEOUTS,
};
