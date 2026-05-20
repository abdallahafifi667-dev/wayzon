const express = require("express");
const router = express.Router();
const ChatController = require("../controllers/ChatController");
const { verifyToken } = require("../middlewares/verifytoken");
router.use(verifyToken);

router.post("/send", ChatController.sendMessage);
router.get("/messages/:userId", ChatController.getMessages);

router.get("/rtc/config", ChatController.getRTCConfig);
router.post("/call/start", ChatController.startCall);
router.post("/call/accept", ChatController.acceptCall);
router.post("/call/reject", ChatController.rejectCall);
router.post("/call/end", ChatController.endCall);

module.exports = router;
