/**
 * Trip Validator
 */

const Joi = require("joi");

const locationUpdateSchema = Joi.object({
  tripId: Joi.string().required().messages({
    "any.required": "Trip ID is required",
  }),
  coordinates: Joi.array().items(Joi.number()).length(2).required().messages({
    "any.required": "Coordinates are required",
    "array.length": "Coordinates must be [longitude, latitude]",
  }),
  accuracy: Joi.number().min(0).max(1000).optional(),
  timestamp: Joi.number().optional(),
});

const safetyResponseSchema = Joi.object({
  tripId: Joi.string().required(),
  response: Joi.object({
    id: Joi.string().required(),
    label: Joi.string().optional(),
    details: Joi.string().optional(),
  }).required(),
});

const routeResponseSchema = Joi.object({
  tripId: Joi.string().required(),
  response: Joi.object({
    id: Joi.string()
      .valid("yes_exploring", "yes_shortcut", "no_lost", "yes_know", "no_help")
      .required(),
    details: Joi.string().optional(),
  }).required(),
});

function validateLocationUpdate(req, res, next) {
  const { error } = locationUpdateSchema.validate(req.body);
  if (error) {
    return res
      .status(400)
      .json({ success: false, message: error.details[0].message });
  }
  next();
}

function validateSafetyResponse(req, res, next) {
  const { error } = safetyResponseSchema.validate(req.body);
  if (error) {
    return res
      .status(400)
      .json({ success: false, message: error.details[0].message });
  }
  next();
}

function validateRouteResponse(req, res, next) {
  const { error } = routeResponseSchema.validate(req.body);
  if (error) {
    return res
      .status(400)
      .json({ success: false, message: error.details[0].message });
  }
  next();
}

module.exports = {
  validateLocationUpdate,
  validateSafetyResponse,
  validateRouteResponse,
  locationUpdateSchema,
  safetyResponseSchema,
  routeResponseSchema,
};
