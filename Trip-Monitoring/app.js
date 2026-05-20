"use strict";
require("dotenv").config();
const express = require("express");
const { connect } = require("./config/conectet");
const securityMiddleware = require("./middlewares/security");
const {
  errorNotFound,
  errorHandler,
  validationErrorHandler,
  databaseErrorHandler,
  authenticationErrorHandler,
} = require("./middlewares/error");
const { attachHealthRoutes } = require("./monitoring/health");
const { logger, MetricsCollector } = require("./monitoring/metrics");
const EventBus = require("./infrastructure/eventBus");

const app = express();
let eventBus;

const initializeApp = async () => {
  try {
    await connect();

    // Initialize EventBus
    eventBus = new EventBus();
    await eventBus.connect();

    const systemMonitoringRoutes = require("./routes/systemMonitoring");
    const tripMonitoringRouter = require("./routes/tripMonitoring");

    // Initialize background services
    const { initializeServices } = require("./services/initServices");
    await initializeServices();
    securityMiddleware(app);

    // Set logger for correlation middleware
    app.set("logger", logger);

    // Attach health and metrics endpoints
    attachHealthRoutes(app, { detailed: true });

    // Middleware to record HTTP metrics
    app.use((req, res, next) => {
      const start = process.hrtime();
      res.on("finish", () => {
        const duration = process.hrtime(start);
        const durationSeconds = duration[0] + duration[1] / 1e9;
        MetricsCollector.recordHttpRequest(
          req.method,
          req.route ? req.route.path : req.path,
          res.statusCode,
          durationSeconds,
        );
      });
      next();
    });

    app.use("/api/system", systemMonitoringRoutes);
    app.use("/api/trip", tripMonitoringRouter);

    // Define EventBus on app for access in routes
    app.set("eventBus", eventBus);

    app.use(validationErrorHandler);
    app.use(databaseErrorHandler);
    app.use(authenticationErrorHandler);
    app.use(errorNotFound);
    app.use(errorHandler);
  } catch (err) {
    logger.error("Failed to initialize app:", err);
    process.exit(1);
  }
};

initializeApp();

module.exports = app;
