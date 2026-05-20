// users/validators/NotificationValidator.js
/**
 * ✅ Notification Validation Schemas
 * Validates all notification operations
 */

const Joi = require("joi");

// ✅ Validate notification sending
const validateNotificationSend = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    title: Joi.string().required().max(100).trim().messages({
      "string.empty": "Title is required",
      "string.max": "Title cannot exceed 100 characters",
      "any.required": "Title is required",
    }),

    message: Joi.string().required().max(500).trim().messages({
      "string.empty": "Message is required",
      "string.max": "Message cannot exceed 500 characters",
      "any.required": "Message is required",
    }),

    type: Joi.string()
      .required()
      .valid("alert", "info", "warning", "success", "error")
      .messages({
        "any.only": "Type must be one of: alert, info, warning, success, error",
        "any.required": "Type is required",
      }),

    action: Joi.object({
      type: Joi.string().valid("navigate", "open_url", "callback"),
      target: Joi.string().max(500),
    })
      .optional()
      .messages({
        "object.base": "Action must be a valid object",
      }),

    data: Joi.object().optional().messages({
      "object.base": "Data must be a valid object",
    }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate notification update
const validateNotificationUpdate = (data) => {
  const schema = Joi.object({
    notificationId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid notification ID format",
        "any.required": "Notification ID is required",
      }),

    status: Joi.string()
      .valid("read", "unread", "archived", "deleted")
      .messages({
        "any.only": "Status must be one of: read, unread, archived, deleted",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate bulk notification update
const validateBulkNotificationUpdate = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    status: Joi.string()
      .required()
      .valid("read", "unread", "archived", "deleted")
      .messages({
        "any.only": "Status must be one of: read, unread, archived, deleted",
        "any.required": "Status is required",
      }),

    filter: Joi.object({
      type: Joi.array()
        .items(
          Joi.string().valid("alert", "info", "warning", "success", "error"),
        )
        .optional(),

      dateRange: Joi.object({
        from: Joi.date().optional(),
        to: Joi.date().optional(),
      }).optional(),
    }).optional(),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate notification preferences
const validateNotificationPreferences = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    channels: Joi.object({
      push: Joi.boolean().default(true),
      email: Joi.boolean().default(true),
      sms: Joi.boolean().default(false),
      inApp: Joi.boolean().default(true),
    })
      .optional()
      .messages({
        "object.base": "Channels must be a valid object",
      }),

    frequency: Joi.string()
      .valid("real-time", "daily_digest", "weekly_digest", "none")
      .default("real-time")
      .messages({
        "any.only":
          "Frequency must be one of: real-time, daily_digest, weekly_digest, none",
      }),

    categories: Joi.object({
      orders: Joi.boolean().default(true),
      messages: Joi.boolean().default(true),
      reviews: Joi.boolean().default(true),
      system: Joi.boolean().default(true),
      marketing: Joi.boolean().default(false),
    })
      .optional()
      .messages({
        "object.base": "Categories must be a valid object",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate notification query
const validateNotificationQuery = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    page: Joi.number().min(1).default(1).messages({
      "number.min": "Page must be at least 1",
    }),

    limit: Joi.number().min(1).max(100).default(10).messages({
      "number.min": "Limit must be at least 1",
      "number.max": "Limit cannot exceed 100",
    }),

    status: Joi.string()
      .valid("read", "unread", "all")
      .default("all")
      .messages({
        "any.only": "Status must be one of: read, unread, all",
      }),

    type: Joi.array()
      .items(Joi.string().valid("alert", "info", "warning", "success", "error"))
      .optional(),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Format validation errors
const formatValidationErrors = (error) => {
  if (!error.details) {
    return "Validation error";
  }

  return error.details.map((detail) => ({
    field: detail.path.join("."),
    message: detail.message,
  }));
};

// Device-level notification payload validation (tokens + title/body)
const validateDeviceNotification = (data) => {
  const schema = Joi.object({
    tokens: Joi.array().items(Joi.string()).min(1).required().messages({
      "array.min": "At least one device token is required",
      "any.required": "Tokens are required",
    }),
    title: Joi.string().required().max(150).messages({
      "string.empty": "Title is required",
      "string.max": "Title cannot exceed 150 characters",
    }),
    body: Joi.string().required().max(1000).messages({
      "string.empty": "Body is required",
      "string.max": "Body cannot exceed 1000 characters",
    }),
    data: Joi.object().optional(),
  });

  return schema.validate(data, { abortEarly: false });
};

// Export the helper
module.exports.validateDeviceNotification = validateDeviceNotification;
