const Joi = require("joi");

const validateSendMessage = (data) => {
  const schema = Joi.object({
    message: Joi.string().required().trim().messages({
      "any.required": "Message is required",
      "string.empty": "Message cannot be empty",
    }),
    messageType: Joi.string()
      .valid("text", "image", "audio")
      .default("text")
      .messages({
        "any.only": "MessageType must be one of: text, image, audio",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

const validateSendMessageAdmin = (data) => {
  const schema = Joi.object({
    userId: Joi.string()
      .required()
      .regex(/^[0-9a-fA-F]{24}$/)
      .messages({
        "string.pattern.base": "Invalid target user ID format",
        "any.required": "Target user ID is required",
      }),
    message: Joi.string().required().trim().messages({
      "any.required": "Message is required",
      "string.empty": "Message cannot be empty",
    }),
    messageType: Joi.string()
      .valid("text", "image", "audio")
      .default("text")
      .messages({
        "any.only": "MessageType must be one of: text, image, audio",
      }),
  });

  return schema.validate(data, { abortEarly: false });
};

const formatValidationErrors = (error) => {
  if (!error.details) return "Validation error";
  return error.details.map((detail) => ({
    field: detail.path.join("."),
    message: detail.message,
  }));
};

module.exports = {
  validateSendMessage,
  validateSendMessageAdmin,
  formatValidationErrors,
};
