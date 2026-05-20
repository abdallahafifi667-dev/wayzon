const { logUserAction } = require("../util/auditLogger");
const Bull = require("bull");

const getRedisConfig = () => {
  const host =
    process.env.REDIS_HOST ||
    (process.env.RUNNING_IN_DOCKER === "1" ? "redis" : "127.0.0.1");
  const port = parseInt(process.env.REDIS_PORT) || 6379;
  const password = process.env.REDIS_PASSWORD || undefined;

  return {
    host,
    port,
    password,
    db: parseInt(process.env.REDIS_QUEUE_DB) || 1, // Separate DB for queues (DB 1)
  };
};

const redisConfig = getRedisConfig();

const queues = {
  tripMonitoring: new Bull("trip-monitoring", { redis: redisConfig }),
  cleanup: new Bull("cleanup", { redis: redisConfig }),
  reassurance: new Bull("reassurance-checks", { redis: redisConfig }),
};

Object.entries(queues).forEach(([name, queue]) => {
  queue.on("error", (error) => {
    logUserAction({
      user: "system",
      ip: "system",
      action: "bull",
      details: {
        action: "bull_queue_error",
        subject: "bull_queue_error",
        error: error.message,
        timestamp: new Date().toISOString(),
      },
    });
  });

  queue.on("failed", (job, error) => {
    logUserAction({
      user: "system",
      ip: "system",
      action: "bull",
      details: {
        action: "bull_queue_failed",
        subject: "bull_queue_failed",
        error: error.message,
        timestamp: new Date().toISOString(),
      },
    });
  });

  queue.on("completed", (job) => {
    logUserAction({
      user: "system",
      ip: "system",
      action: "bull",
      details: {
        action: "bull_queue_completed",
        subject: "bull_queue_completed",
        error: error.message,
        timestamp: new Date().toISOString(),
      },
    });
  });

  queue.on("stalled", (job) => {
    logUserAction({
      user: "system",
      ip: "system",
      action: "bull",
      details: {
        action: "bull_queue_stalled",
        subject: "bull_queue_stalled",
        error: error.message,
        timestamp: new Date().toISOString(),
      },
    });
  });
});

// Graceful shutdown
const shutdown = async () => {
  console.log("🛑 Shutting down Bull queues...");

  await Promise.all(Object.values(queues).map((queue) => queue.close()));

  console.log("✅ All queues closed");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = queues;
