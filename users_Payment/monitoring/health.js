const express = require("express");
const { register, MetricsCollector, logger } = require("./metrics");
const { client: redisClient } = require("../config/redis");
const { Kafka, logLevel } = require("kafkajs");

const healthChecks = {
  redis: async () => {
    try {
      if (!redisClient.isOpen)
        return { status: "down", message: "Not connected" };
      await redisClient.ping();
      return { status: "up", message: "Connected" };
    } catch (err) {
      return { status: "down", message: err.message };
    }
  },

  kafka: async () => {
    try {
      const { logger } = require("./metrics");

      const kafkajsHealthLogCreator =
        () =>
        ({ namespace, level, label, log }) => {
          try {
            const msg = log && log.message ? String(log.message) : "";
            const errText =
              log && log.error ? String(log.error.message || log.error) : "";
            if (msg.includes("Response SyncGroup") || /rebalanc/i.test(errText))
              return;
            const meta = Object.assign(
              { namespace, label, kafkajsLevel: level },
              log || {},
            );
            const lvl = String(level || "").toLowerCase();
            if (lvl.includes("error") || lvl === "2")
              logger.error(msg || "[kafkajs]", meta);
            else if (lvl.includes("warn") || lvl === "1")
              logger.warn(msg || "[kafkajs]", meta);
            else logger.info(msg || "[kafkajs]", meta);
          } catch (e) {
            logger.error("kafkajs health logCreator error", e);
          }
        };

      const kafka = new Kafka({
        clientId: "health-check",
        brokers: process.env.KAFKA_BROKERS?.split(",") || ["localhost:9092"],
        logLevel: logLevel.ERROR,
        logCreator: kafkajsHealthLogCreator,
      });
      const admin = kafka.admin();
      await admin.connect();
      const cluster = await admin.describeCluster();
      await admin.disconnect();
      return {
        status: "up",
        message: `${cluster.brokers.length} brokers`,
      };
    } catch (err) {
      return { status: "down", message: err.message };
    }
  },

  mongodb: async () => {
    try {
      const { getOrderModel } = require("../models/order.models");
      const Order = getOrderModel();
      await Order.findOne({}).lean();
      return { status: "up", message: "Connected" };
    } catch (err) {
      return { status: "down", message: err.message };
    }
  },
};

// ==================== MIDDLEWARE FACTORY ====================

/**
 * Create health and metrics routes
 * @param {object} options - Configuration options
 * @returns {express.Router}
 */
function createHealthRoutes(options = {}) {
  const router = express.Router();
  const { detailed = true } = options;

  /**
   * GET /health - Kubernetes liveness probe
   * Returns 200 if service is running
   */
  router.get("/health/live", async (req, res) => {
    try {
      res.json({
        status: "alive",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  /**
   * GET /health/ready - Kubernetes readiness probe
   * Returns 200 only if all dependencies are ready
   */
  router.get("/health/ready", async (req, res) => {
    try {
      if (!detailed) {
        return res.json({ status: "ready" });
      }

      const checks = await Promise.all(
        Object.entries(healthChecks).map(async ([name, check]) => ({
          [name]: await check(),
        })),
      );

      const health = Object.assign({}, ...checks);
      const allHealthy = Object.values(health).every((h) => h.status === "up");

      res.status(allHealthy ? 200 : 503).json({
        status: allHealthy ? "ready" : "not-ready",
        timestamp: new Date().toISOString(),
        checks: health,
      });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  /**
   * GET /health - Summary health check
   */
  router.get("/health", async (req, res) => {
    try {
      if (!detailed) {
        return res.json({
          status: "ok",
          timestamp: new Date().toISOString(),
        });
      }

      const checks = await Promise.all(
        Object.entries(healthChecks).map(async ([name, check]) => ({
          [name]: await check(),
        })),
      );

      const health = Object.assign({}, ...checks);
      const allHealthy = Object.values(health).every((h) => h.status === "up");

      res.status(allHealthy ? 200 : 503).json({
        status: allHealthy ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
        checks: health,
      });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  /**
   * GET /metrics - Prometheus metrics endpoint
   */
  router.get("/metrics", async (req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end(err.message);
    }
  });

  /**
   * GET /health/redis - Redis health only
   */
  router.get("/health/redis", async (req, res) => {
    const health = await healthChecks.redis();
    MetricsCollector.setRedisConnected(health.status === "up");
    res.status(health.status === "up" ? 200 : 503).json(health);
  });

  /**
   * GET /health/kafka - Kafka health only
   */
  router.get("/health/kafka", async (req, res) => {
    const health = await healthChecks.kafka();
    MetricsCollector.setKafkaConnected(health.status === "up");
    res.status(health.status === "up" ? 200 : 503).json(health);
  });

  /**
   * GET /health/db - MongoDB health only
   */
  router.get("/health/db", async (req, res) => {
    const health = await healthChecks.mongodb();
    res.status(health.status === "up" ? 200 : 503).json(health);
  });

  /**
   * GET /stats - System statistics
   */
  router.get("/stats", (req, res) => {
    const stats = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };
    res.json(stats);
  });

  return router;
}

// ==================== MIDDLEWARE FUNCTION ====================

/**
 * Add health and metrics middleware to Express app
 * @param {express.Application} app
 * @param {object} options
 */
function attachHealthRoutes(app, options = {}) {
  const routes = createHealthRoutes(options);
  app.use(routes);
}

module.exports = {
  createHealthRoutes,
  attachHealthRoutes,
  healthChecks,
};
