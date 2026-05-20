const { getAuditModel } = require("../models/Audit.models");

async function logUserAction({ userId, user, ip, action, details = [] }) {
  try {
    const Audit = getAuditModel();

    // Handle userId/user alias mismatch
    let finalUserId = userId || user;

    // If user is "system" or not a valid ObjectId, don't set userId field (it refers to User model)
    if (
      finalUserId === "system" ||
      (typeof finalUserId === "string" &&
        !/^[0-9a-fA-F]{24}$/.test(finalUserId))
    ) {
      finalUserId = undefined;
      // Optionally add "system" to details or action if needed, but "action" usually captures context
    }

    await Audit.create({
      userId: finalUserId,
      ip: ip || details.ip, // Support IP from details
      userAgent: details.userAgent, // Support UserAgent from details
      action,
      details,
    });
  } catch (err) {
    console.error("Audit logUserAction error:", err.message);
  }
}

async function logSecurityEvent({ ip, action, details = [] }) {
  try {
    const Audit = getAuditModel();
    await Audit.create({
      ip,
      action: `[SECURITY] ${action}`,
      details,
    });
  } catch (err) {
    console.error("Audit logSecurityEvent error:", err.message);
  }
}
module.exports = {
  logUserAction,
  logSecurityEvent,
};
