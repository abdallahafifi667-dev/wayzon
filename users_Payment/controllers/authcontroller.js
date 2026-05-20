const bcrypt = require("bcrypt");
const asyncHandler = require("express-async-handler");
const xss = require("xss");
const Joi = require("joi");
const {
  generateTokenAndSend,
  verifyAndDecryptToken,
} = require("../middlewares/genarattokenandcookies");
const {
  validateRegister,
  validateLogin,
  formatValidationErrors: formatAuthValidationErrors,
} = require("../validators/AuthValidator");
const { validateLocationUpdate } = require("../validators/ProfileValidator");
const emailService = require("../util/sendGemail");
const { getUserModel } = require("../models/users.models");
const User = getUserModel();
const { logUserAction } = require("../util/auditLogger");
const { refreshAccessToken } = require("../middlewares/genarattokenandcookies");

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */

exports.register = asyncHandler(async (req, res) => {
  const sanitizedLanguages = Array.isArray(req.body.languages)
    ? req.body.languages.map((lang) => ({
      name: xss(lang.name),
      proficiency: xss(lang.proficiency),
    }))
    : [];

  const data = {
    role: xss(req.body.role),
    username: xss(req.body.username),
    email: xss(req.body.email),
    password: xss(req.body.password),
    phone: xss(req.body.phone),
    country: xss(req.body.country),
    Address: xss(req.body.Address),
    identityNumber: xss(req.body.identityNumber),
    IpPhone: xss(req.body.IpPhone),
    location: {
      type: "Point",
      coordinates: [
        parseFloat(xss(req.body.longitude)),
        parseFloat(xss(req.body.latitude)),
      ],
    },
    languages: sanitizedLanguages,
    gender: xss(req.body.gender),
    fcmToken: xss(req.body.fcmToken),
  };

  const { error } = validateRegister(data);
  if (error) {
    return res.status(400).json({ error: formatAuthValidationErrors(error) });
  }

  // Check email address in new structure
  const userExists = await User.findOne({ "email.address": data.email });
  if (userExists)
    return res.status(401).json({ error: "User already exists!" });

  // Check duplicate identity in KYC collection
  const { getUserKYCModel } = require("../models/users.models");
  const UserKYC = getUserKYCModel();

  const idExists = await UserKYC.findOne({
    identityNumber: data.identityNumber,
  });
  if (idExists)
    return res
      .status(401)
      .json({ error: "Identity number already registered!" });

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(data.password, salt);

  const verificationCode = Math.floor(
    100000 + Math.random() * 900000,
  ).toString();

  const newUser = new User({
    role: data.role,
    username: data.username,
    email: {
      address: data.email,
      verified: false,
      verificationCode: verificationCode,
    },
    password: hashedPassword,
    phone: data.phone,
    location: data.location,
    country: data.country,
    Address: data.Address,
    languages: data.languages,
    gender: data.gender,
    fcmTokens: data.fcmToken ? [data.fcmToken] : [],
    IpPhone: data.IpPhone,
  });

  try {
    await newUser.save();

    // Post-save hook creates Wallet and KYC
    // We should update the KYC with the identity number we received
    await UserKYC.findOneAndUpdate(
      { userId: newUser._id },
      { identityNumber: data.identityNumber },
      { upsert: true }, // Should exist, but safe
    );

    const result = await emailService.sendVerificationEmail({
      to: data.email,
      verificationCode,
      username: data.username || data.email,
    });

    if (!result || !result.success) {
      return res
        .status(500)
        .json({ error: "Failed to send verification email" });
    }

    generateTokenAndSend(newUser, res, {
      message: "Verification email sent successfully",
      userId: newUser._id,
    });

    logUserAction({
      user: newUser._id,
      ip: req.ip,
      action: "user",
      details: { action: "register", subject: "register" },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
    logUserAction({
      user: newUser._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "register",
        subject: "register",
        error: error.message,
      },
    });
  }
});

/**
 * @desc    Verify email address
 * @route   POST /api/auth/verifyEmail
 * @access  Public
 */
exports.verifyEmail = asyncHandler(async (req, res) => {
  try {
    const data = { code: xss(req.body.code) };
    const schema = Joi.object({ code: Joi.string().required() });
    const { error } = schema.validate(data);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const user = await User.findOne({
      _id: req.user._id,
      "email.verificationCode": data.code,
    });

    if (!user)
      return res.status(404).json({ error: "User not found or invalid code!" });

    user.email.verified = true;
    user.email.verificationCode = null;
    await user.save();

    generateTokenAndSend(user, res, {
      message: "Email verified successfully!",
      userId: user._id,
    });

    logUserAction({
      user: user._id,
      ip: req.ip,
      action: "user",
      details: { action: "verifyEmail", subject: "verifyEmail" },
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "verifyEmail",
        subject: "verifyEmail",
        error: error.message,
      },
    });
  }
});

/**
 * @desc    User login
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.login = asyncHandler(async (req, res) => {
  try {
    const identifierRaw =
      (req.body.identifier && String(req.body.identifier).trim()) ||
      (req.body.email && String(req.body.email).trim()) ||
      (req.body.phone && String(req.body.phone).trim()) ||
      "";

    const data = {
      identifier: xss(identifierRaw),
      password: xss(req.body.password),
      fcmToken: req.body.fcmToken ? xss(String(req.body.fcmToken)) : undefined,
    };

    const { error, value } = validateLogin(data);
    if (error)
      return res.status(400).json({ error: formatAuthValidationErrors(error) });

    const id = value.identifier;
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);

    let user;
    if (isEmail) {
      user = await User.findOne({ "email.address": id.toLowerCase() });
    } else {
      const compact = id.replace(/\s/g, "");
      user = await User.findOne({
        $or: [{ phone: id }, { phone: compact }],
      });
    }
    if (!user)
      return res.status(400).json({ error: "Invalid email or password!" });

    const validPassword = await bcrypt.compare(data.password, user.password);
    if (!validPassword)
      return res.status(400).json({ error: "Invalid email or password!" });

    const { getUserKYCModel } = require("../models/users.models");
    const UserKYC = getUserKYCModel();
    const kyc = await UserKYC.findOne({ userId: user._id });
    const isDocVerified = kyc ? kyc.documentation : false;

    if (user.email.verified && isDocVerified === false) {
      return res.status(401).json({ error: false });
    }

    const fcmToken = value.fcmToken;
    if (fcmToken) {
      if (!user.fcmTokens.includes(fcmToken)) {
        user.fcmTokens.push(fcmToken);
        if (user.fcmTokens.length > 5)
          user.fcmTokens = user.fcmTokens.slice(-5);
        await user.save();
      }
    }

    generateTokenAndSend(user, res, { 
      id: user._id, 
      avatar: user.avatar,
      username: user.username,
      role: user.role,
      phone: user.phone
    });

    logUserAction({
      user: user._id,
      ip: req.ip,
      action: "user",
      details: { action: "login", subject: "login" },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
    logUserAction({
      user: req.user?._id || null,
      ip: req.ip,
      action: "user",
      details: { action: "login", subject: "login", error: error.message },
    });
  }
});

/**
 * @desc    Update user location
 * @route   PATCH /api/auth/updateLocation
 * @access  Public
 */
exports.updateLocation = asyncHandler(async (req, res) => {
  try {
    const data = {
      location: {
        type: "Point",
        coordinates: [
          parseFloat(xss(req.body.longitude)),
          parseFloat(xss(req.body.latitude)),
        ],
      },
    };
    const locationPayload = {
      userId: String(req.user._id),
      coordinates: data.location.coordinates,
    };
    const { error } = validateLocationUpdate(locationPayload);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: data },
      { new: true },
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    generateTokenAndSend(user, res, {
      message: "Location updated successfully",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @desc    Verify phone number
 * @route   POST /api/auth/viledLogin
 * @access  Public
 */
exports.viledLogin = asyncHandler(async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (fcmToken) {
      await User.findByIdAndUpdate(req.user._id, {
        $addToSet: { fcmTokens: fcmToken },
      });

      const userDoc = await User.findById(req.user._id);
      if (userDoc && !userDoc.fcmTokens.includes(fcmToken)) {
        userDoc.fcmTokens.push(fcmToken);
        await userDoc.save();
      }
    }

    generateTokenAndSend(req.user, res, {
      message: `Welcome back ${req.user.username}`,
    });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "viledLogin",
        subject: "viledLogin",
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "viledLogin",
        subject: "viledLogin",
        error: error.message,
      },
    });
  }
});

/**
 * @desc    User logout
 * @route   POST /api/auth/logout
 * @access  Private
 */
exports.logout = asyncHandler(async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (fcmToken) {
      const user = await User.findById(req.user._id);
      if (user) {
        user.fcmTokens = user.fcmTokens.filter((token) => token !== fcmToken);
        await user.save();
      }
    }

    res.setHeader("x-auth-token", "");
    res.status(200).json({ message: "Logged out successfully" });

    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "logout",
        subject: "logout",
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
    logUserAction({
      user: req.user._id,
      ip: req.ip,
      action: "user",
      details: {
        action: "logout",
        subject: "logout",
        error: error.message,
      },
    });
  }
});

/**
 * @desc    Refresh access token using refresh token
 * @route   POST /api/auth/refresh
 * @access  Public
 */

exports.Refresh = asyncHandler(async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: "refreshToken is required in request body",
      });
    }

    const {
      accessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiry,
    } = refreshAccessToken(refreshToken);

    // Send tokens via headers (primary for mobile)
    res.setHeader("auth-token", accessToken);
    res.setHeader("refresh-token", newRefreshToken);

    // Also send in response body (as backup)
    return res.status(200).json({
      success: true,
      accessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiry,
      tokenType: "Bearer",
      message: "Token refreshed successfully - session extended indefinitely",
    });
  } catch (error) {
    console.error("[REFRESH] Error:", error);
    return res.status(401).json({
      error: "Failed to refresh token",
      message: error.message,
    });
  }
});
