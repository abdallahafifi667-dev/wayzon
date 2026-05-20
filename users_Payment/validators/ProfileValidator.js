// users/validators/ProfileValidator.js
/**
 * ✅ Profile & User Data Validation Schemas
 * Validates all profile operations and user data
 */

const Joi = require("joi");

// ✅ Validate profile image upload
const validateProfileImageUpload = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    imageUrl: Joi.string().required().uri().messages({
      "string.uri": "Image URL must be valid",
      "any.required": "Image URL is required",
    }),

    imageType: Joi.string()
      .valid("profile", "document", "verification")
      .default("profile")
      .messages({
        "any.only":
          "Image type must be one of: profile, document, verification",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate location update
const validateLocationUpdate = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    coordinates: Joi.array()
      .length(2)
      .items(
        Joi.number().min(-180).max(180).required().messages({
          "number.min": "Longitude must be >= -180",
          "number.max": "Longitude must be <= 180",
        }),
        Joi.number().min(-90).max(90).required().messages({
          "number.min": "Latitude must be >= -90",
          "number.max": "Latitude must be <= 90",
        }),
      )
      .required()
      .messages({
        "array.length":
          "Coordinates must have exactly 2 values [longitude, latitude]",
        "any.required": "Coordinates are required",
      }),

    address: Joi.string().max(200).messages({
      "string.max": "Address cannot exceed 200 characters",
    }),

    city: Joi.string().max(50).messages({
      "string.max": "City name cannot exceed 50 characters",
    }),

    country: Joi.string().max(50).messages({
      "string.max": "Country name cannot exceed 50 characters",
    }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate preferences update
const validatePreferencesUpdate = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    languages: Joi.array().items(Joi.string().max(50)).max(5).messages({
      "array.max": "Cannot have more than 5 languages",
    }),

    interests: Joi.array().items(Joi.string().max(50)).max(10).messages({
      "array.max": "Cannot have more than 10 interests",
    }),

    skills: Joi.array().items(Joi.string().max(50)).max(10).messages({
      "array.max": "Cannot have more than 10 skills",
    }),

    availability: Joi.object({
      days: Joi.array()
        .items(
          Joi.string().valid(
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
          ),
        )
        .messages({
          "any.only": "Day must be a valid day of the week",
        }),

      startTime: Joi.string()
        .pattern(/^\d{2}:\d{2}$/)
        .messages({
          "string.pattern.base": "Start time must be in format HH:MM",
        }),

      endTime: Joi.string()
        .pattern(/^\d{2}:\d{2}$/)
        .messages({
          "string.pattern.base": "End time must be in format HH:MM",
        }),
    }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate wallet/payment info update
const validatePaymentInfoUpdate = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    paymentMethod: Joi.string()
      .valid("credit_card", "bank_transfer", "wallet", "paypal")
      .messages({
        "any.only": "Invalid payment method",
      }),

    accountNumber: Joi.string()
      .when("paymentMethod", {
        is: "bank_transfer",
        then: Joi.required(),
        otherwise: Joi.optional(),
      })
      .messages({
        "any.required": "Account number required for bank transfer",
      }),

    bankName: Joi.string()
      .when("paymentMethod", {
        is: "bank_transfer",
        then: Joi.required(),
        otherwise: Joi.optional(),
      })
      .messages({
        "any.required": "Bank name required for bank transfer",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate emergency contact update
const validateEmergencyContactUpdate = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "User ID is required",
      }),

    name: Joi.string().required().min(3).max(100).messages({
      "string.empty": "Contact name is required",
      "string.min": "Contact name must be at least 3 characters",
      "string.max": "Contact name cannot exceed 100 characters",
    }),

    phone: Joi.string()
      .required()
      .pattern(/^[0-9+\-\(\)\s]+$/)
      .max(20)
      .messages({
        "string.pattern.base": "Phone number format is invalid",
        "any.required": "Phone number is required",
      }),

    relationship: Joi.string()
      .valid("family", "friend", "colleague", "other")
      .required()
      .messages({
        "any.only":
          "Relationship must be one of: family, friend, colleague, other",
        "any.required": "Relationship is required",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

// ✅ Validate profile update (phone, description, gender)
const validateProfileUpdate = (data) => {
  const schema = Joi.object({
    phone: Joi.string()
      .pattern(/^[0-9+\-\(\)\s]+$/)
      .max(20)
      .messages({
        "string.pattern.base": "Phone number format is invalid",
      }),
    description: Joi.string().max(500).messages({
      "string.max": "Description cannot exceed 500 characters",
    }),
    gender: Joi.string().required().valid("male", "female", "other").messages({
      "any.only": "Gender must be one of: male, female, other",
      "any.required": "Gender is required",
    }),
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

module.exports = {
  validateProfileImageUpload,
  validateLocationUpdate,
  validatePreferencesUpdate,
  validatePaymentInfoUpdate,
  validateEmergencyContactUpdate,
  validateProfileUpdate,
  formatValidationErrors,
};
