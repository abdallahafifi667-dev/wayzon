"use strict";

require("dotenv").config();

process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1";
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

    const orderRouter = require("./routes/order");
    const chatRouter = require("./routes/chat");
    const usersRouter = require("./routes/users");
    const forgetpassword = require("./routes/forgetpassword");
    const profileRouter = require("./routes/profile");
    const languagesRouter = require("./routes/languages");
    const reviewRoutes = require("./routes/reviewRoutes");
    const systemMonitoringRoutes = require("./routes/systemMonitoring");
    const paymentRouter = require("./routes/payment");
    const supportRouter = require("./routes/support");

    // Initialize background services (missing person monitor)
    require("./util/initServices");

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

    app.use("/users", usersRouter);
    app.use("/forget-password", forgetpassword);
    app.use("/api/user", profileRouter);
    app.use("/api/user/languages", languagesRouter);
    app.use("/api/review", reviewRoutes);
    app.use("/api/system", systemMonitoringRoutes);
    app.use("/api/order", orderRouter);
    app.use("/api/chat", chatRouter);
    app.use("/api/payment", paymentRouter);
    app.use("/api/support", supportRouter);



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
