const Joi = require("joi");

const formatValidationErrors = (error) => {
  if (!error.details) {
    return "Validation error";
  }

  return error.details.map((detail) => ({
    field: detail.path.join("."),
    message: detail.message,
  }));
};

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

module.exports.validateDeviceNotification = validateDeviceNotification;
