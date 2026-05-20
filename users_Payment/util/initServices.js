const { logUserAction } = require("../util/auditLogger");

try {
  require("../workers/reviewWorker");

  require("../workers/profileWorker");
  require("./FCMCleanupService");
} catch (error) {
  logUserAction({
    user: "system",
    action: "initServices",
    details: {
      action: "initServices",
      error: error.message,
    },
  });
  throw error;
}
