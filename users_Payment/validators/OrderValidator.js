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

const validateOrderDataController = (data) => {
  const schema = Joi.object({
    serviceType: Joi.string().valid("with_guide", "solo_system").required(),
    destinationStatus: Joi.string()
      .valid("defined", "undefined")
      .default("defined"),
    normal: Joi.string().required(),
    title: Joi.string().min(3).max(100).optional(),
    description: Joi.string().min(10).max(1500).optional(),
    TripDate: Joi.date().required(),
    duration: Joi.number().min(1).max(12).required(),
    locations: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().required(),
          type: Joi.string().valid("Point").required(),
          coordinates: Joi.array().items(Joi.number()).length(2).required(),
        }),
      )
      .min(1)
      .when("destinationStatus", {
        is: "defined",
        then: Joi.required(),
        otherwise: Joi.optional().allow(null, []),
      }),
    meetingPoint: Joi.object({
      type: Joi.string().valid("Point").required(),
      coordinates: Joi.array().items(Joi.number()).length(2).required(),
    }).when("destinationStatus", {
      is: "defined",
      then: Joi.required(),
      otherwise: Joi.optional().allow(null),
    }),
    safetyConfig: Joi.object({
      plan: Joi.string().valid("free", "premium").default("free"),
    }).optional(),
    status: Joi.string()
      .valid("open", "bidding", "offer_selected", "awaiting_guide_confirmation")
      .optional(),
    price: Joi.number().min(1).max(1000).required(),
    destinationCountry: Joi.string().required().messages({
      "string.empty": "Destination country is required",
      "any.required": "Destination country is required",
    }),
    isSolo: Joi.boolean().optional(),
    companionsCount: Joi.number().min(0).optional(),
  });

  return schema.validate(data, { abortEarly: false });
};

const validateOrderDatasController = (data) => {
  const schema = Joi.object({
    serviceType: Joi.string().valid("with_guide", "solo_system").required(),
    normal: Joi.string().required(),
    guide: Joi.string().required(),
    title: Joi.string().min(3).max(100).optional(),
    description: Joi.string().min(10).max(1500).optional(),
    TripDate: Joi.date().required(),
    duration: Joi.number().min(1).max(12).required(),
    location: Joi.object({
      type: Joi.string().valid("Point").required(),
      coordinates: Joi.array().items(Joi.number()).length(2).required(),
    }).required(),
    meetingPoint: Joi.object({
      type: Joi.string().valid("Point").required(),
      coordinates: Joi.array().items(Joi.number()).length(2).required(),
    }).required(),
    safetyConfig: Joi.object({
      plan: Joi.string().valid("free", "premium").default("free"),
    }).optional(),
    status: Joi.string().valid("awaiting_guide_confirmation").optional(),
    price: Joi.number().min(1).required(),
    isSolo: Joi.boolean().optional(),
    companionsCount: Joi.number().min(0).optional(),
  });

  return schema.validate(data, { abortEarly: false });
};

module.exports = {
  formatValidationErrors,
  validateOrderDataController,
  validateOrderDatasController,
};
