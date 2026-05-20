const { createClient } = require("redis");
const { logger } = require("../monitoring/metrics");

// Support multiple running environments:
// 1) Explicit `REDIS_URL` env var (highest priority)
// 2) `REDIS_HOST` + `REDIS_PORT` (useful when running on host or in k8s/docker with service name)
// 3) If `RUNNING_IN_DOCKER=1` assume service name `redis`
// 4) Otherwise default to localhost for local development
const REDIS_URL =
  process.env.REDIS_URL ||
  (() => {
    const host =
      process.env.REDIS_HOST ||
      (process.env.RUNNING_IN_DOCKER === "1" ? "redis" : "127.0.0.1");
    const port = process.env.REDIS_PORT || 6379;
    return `redis://${host}:${port}`;
  })();

const client = createClient({ url: REDIS_URL });

client.on("error", (err) => {
  logger.error("Redis Client Error", { error: err });
});

async function connectRedis() {
  if (!client.isOpen) {
    await client.connect();
    logger.info("Connected to Redis", { status: "success" });
  }
  return client;
}

module.exports = {
  client,
  connectRedis,
};

const setupGracefulShutdown = () => {
  const shutdownHandler = async (signal) => {
    logger.info(`${signal} received, closing Redis connections...`);
    try {
      // Give ongoing operations a moment
      setTimeout(async () => {
        try {
          if (client.isOpen) {
            await client.quit(); // preferred over disconnect
            logger.info("Redis connection closed gracefully");
          }
        } catch (err) {
          logger.error("Error closing Redis connection:", err);
        } finally {
          process.exit(0);
        }
      }, 1000);
    } catch (err) {
      logger.error("Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => shutdownHandler("SIGINT"));
};

setupGracefulShutdown();
