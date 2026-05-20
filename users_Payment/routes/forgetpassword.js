var router = require("express").Router();
const {
  sendResetPasswordEmail,
  validateResetPasswordCode,
  resetPassword,
} = require("../controllers/forgetpassword.controllers");

router.post("/send-reset-password-email", sendResetPasswordEmail);
router.post("/validate-reset-password-code", validateResetPasswordCode);
router.post("/reset-password", resetPassword);

module.exports = router;
