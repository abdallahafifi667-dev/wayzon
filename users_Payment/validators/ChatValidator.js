const Joi = require("joi");

const validateSendMessage = (data) => {
  const schema = Joi.object({
    to: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid user ID format",
        "any.required": "Recipient ID (to) is required",
      }),

    message: Joi.string().required().min(1).max(5000).trim().messages({
      "string.empty": "Message cannot be empty",
      "string.max": "Message cannot exceed 5000 characters",
      "any.required": "Message is required",
    }),

    orderId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid order ID format",
        "any.required": "Order ID is required",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

const validateCoordinates = (coords) => {
  const schema = Joi.object({
    type: Joi.string().default("Point").valid("Point").messages({
      "any.only": 'Type must be "Point"',
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
  });

  return schema.validate(coords, { abortEarly: false });
};

const validateLocationUpdate = (data) => {
  const schema = Joi.object({
    orderId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid order ID format",
        "any.required": "Order ID is required",
      }),

    role: Joi.string().required().valid("guide", "normal").messages({
      "any.only": 'Role must be either "guide" or "normal"',
      "any.required": "Role is required",
    }),

    coordinates: Joi.array()
      .length(2)
      .items(
        Joi.number().min(-180).max(180).required(),
        Joi.number().min(-90).max(90).required(),
      )
      .required()
      .messages({
        "array.length":
          "Coordinates must have exactly 2 values [longitude, latitude]",
        "any.required": "Coordinates are required",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

const validateCallSignal = (data) => {
  const schema = Joi.object({
    to: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid recipient ID format",
        "any.required": "Recipient ID is required",
      }),

    orderId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid order ID format",
        "any.required": "Order ID is required",
      }),

    signal: Joi.object().required().messages({
      "any.required": "Signal (SDP offer/answer) is required",
    }),
  });

  return schema.validate(data, { abortEarly: false });
};

const validateCallRejection = (data) => {
  const schema = Joi.object({
    to: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid recipient ID format",
        "any.required": "Recipient ID is required",
      }),

    orderId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid order ID format",
        "any.required": "Order ID is required",
      }),

    reason: Joi.string().max(500).optional().messages({
      "string.max": "Reason cannot exceed 500 characters",
    }),
  });

  return schema.validate(data, { abortEarly: false });
};

const formatValidationErrors = (joiError) => {
  const errors = {};
  joiError.details.forEach((detail) => {
    const key = detail.path.join(".");
    errors[key] = detail.message;
  });
  return errors;
};

module.exports = {
  validateSendMessage,
  validateCoordinates,
  validateLocationUpdate,
  validateCallSignal,
  validateCallRejection,
  formatValidationErrors,
};
