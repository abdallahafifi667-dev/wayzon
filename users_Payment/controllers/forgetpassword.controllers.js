const bcrypt = require("bcrypt");
const asyncHandler = require("express-async-handler");
const passwordComplexity = require("joi-password-complexity");
const xss = require("xss");
const Joi = require("joi");
const emailService = require("../util/sendGemail");
const {
  generateTokenAndSend,
} = require("../middlewares/genarattokenandcookies");
const { getUserModel } = require("../models/users.models");
const User = getUserModel();
const { logUserAction } = require("../util/auditLogger");

const complexityOptions = {
  min: 8,
  max: 30,
  lowerCase: 1,
  upperCase: 1,
  numeric: 1,
  symbol: 1,
  requirementCount: 4,
};

function findUserByEmailAddress(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return User.findOne({ "email.address": normalized });
}

/**
 * إرسال بريد إعادة تعيين كلمة المرور
 */
exports.sendResetPasswordEmail = asyncHandler(async (req, res) => {
  const email = xss(req.body.email?.trim());
  const { error } = validateEmail({ email });
  if (error) return res.status(400).json({ error: error.details[0].message });

  const user = await findUserByEmailAddress(email);
  if (!user) return res.status(404).json({ error: "User not found" });

  const resetCode = String(Math.floor(100000 + Math.random() * 900000));
  user.resetPasswordCode = resetCode;

  try {
    await user.save();
    const emailAddress = user.email?.address || email;
    const result = await emailService.sendPasswordResetEmail({
      to: emailAddress,
      resetToken: resetCode,
      username: user.username || emailAddress,
    });

    if (!result || !result.success)
      return res.status(500).json({ error: "Failed to send email" });

    res.status(200).json({ message: "Reset password code sent successfully" });

    logUserAction({
      user: user._id,
      ip: req.ip,
      action: "user",
      details: { action: "sendResetPasswordEmail" },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to send email" });
    logUserAction({
      user: user._id,
      ip: req.ip,
      action: "user",
      details: { action: "sendResetPasswordEmail", error: err.message },
    });
  }
});

/**
 * التحقق من الكود المرسل
 */
exports.validateResetPasswordCode = asyncHandler(async (req, res) => {
  const email = xss(req.body.email?.trim());
  const code = xss(req.body.code);

  const { error } = validateEmail({ email });
  if (error) return res.status(400).json({ error: error.details[0].message });

  const user = await findUserByEmailAddress(email);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (String(user.resetPasswordCode || "") !== String(code))
    return res.status(400).json({ error: "Invalid code" });

  res.status(200).json({ message: "Code is valid" });

  logUserAction({
    user: user._id,
    ip: req.ip,
    action: "user",
    details: { action: "validateResetPasswordCode" },
  });
});

/**
 * إعادة تعيين كلمة المرور
 */
exports.resetPassword = asyncHandler(async (req, res) => {
  let userId = null;
  try {
    const email = xss(req.body.email?.trim());
    const password = xss(req.body.password);

    const { error } = validatePassword({ password });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const user = await findUserByEmailAddress(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    userId = user._id;

    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = hashedPassword;
    user.resetPasswordCode = null;
    await user.save();

    res.clearCookie("auth-token");
    res.setHeader("auth-token", "");
    generateTokenAndSend(user, res, {
      message: "Password reset successfully",
      id: String(user._id),
      avatar: user.avatar,
    });

    logUserAction({
      user: user._id,
      ip: req.ip,
      action: "user",
      details: { action: "resetPassword" },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password" });
    logUserAction({
      user: userId,
      ip: req.ip,
      action: "user",
      details: { action: "resetPassword", error: error.message },
    });
  }
});

/**
 * التحقق من صحة البريد
 */
function validateEmail(data) {
  const schema = Joi.object({ email: Joi.string().email().required() });
  return schema.validate(data);
}

/**
 * التحقق من قوة كلمة المرور
 */
function validatePassword(data) {
  const schema = Joi.object({
    password: passwordComplexity(complexityOptions).required(),
  });
  return schema.validate(data);
}
