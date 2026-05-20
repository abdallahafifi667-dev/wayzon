const express = require("express");
const router = express.Router();
const { verifyTokenUpPhoto } = require("../middlewares/verifytoken");
const {
  sendSupportMessageUser,
  getSupportMessagesUser,
  getSupportSessionsAdmin,
  getSupportMessagesAdmin,
  sendSupportMessageAdmin,
  resolveSupportSessionAdmin,
} = require("../controllers/supportController");

// User Support Live Chat
router.post("/tickets/message", verifyTokenUpPhoto, sendSupportMessageUser);
router.get("/tickets/messages", verifyTokenUpPhoto, getSupportMessagesUser);

// Admin Helpdesk Dashboard
router.get("/admin/sessions", verifyTokenUpPhoto, getSupportSessionsAdmin);
router.get("/admin/messages/:userId", verifyTokenUpPhoto, getSupportMessagesAdmin);
router.post("/admin/message", verifyTokenUpPhoto, sendSupportMessageAdmin);
router.patch("/admin/resolve/:userId", verifyTokenUpPhoto, resolveSupportSessionAdmin);

module.exports = router;
