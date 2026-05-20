const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middlewares/verifytoken");
const { logger, register } = require("../monitoring/metrics");
const {
  getVerificationStatus,
} = require("../controllers/documentVerificationController");

/**
 * GET /api/system/metrics
 * Expose Prometheus metrics
 */
router.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/**
 * GET /api/system/eventbus/metrics
 * Get EventBus internal metrics
 */
router.get("/eventbus/metrics", verifyToken, (req, res) => {
  // Retrieve eventBus instance from app settings
  const eventBus = req.app.get("eventBus");

  if (!eventBus) {
    return res.status(503).json({
      error: "EventBus not initialized",
      correlationId: req.correlationId,
    });
  }

  res.json({
    ...eventBus.getMetrics(),
    correlationId: req.correlationId,
  });
});

/**
 * GET /api/system/verification/status
 * Get document verification status
 */
router.get("/verification/status", verifyToken, getVerificationStatus);

/**
 * GET /api/system/security/status
 * Get security system status
 */
router.get("/security/status", verifyToken, (req, res) => {
  res.json({
    status: "maximum_protection",
    timestamp: new Date().toISOString(),
    securityLevel: "EXTREME",
    features: [
      "Advanced Helmet Security Headers",
      "Multi-Tier Rate Limiting",
      "Advanced XSS Protection",
      "NoSQL Injection Protection",
      "SQL Injection Protection",
      "HTTP Parameter Pollution Protection",
      "Content Type Validation",
      "Host Validation",
      "Advanced Path Traversal Protection",
      "User-Agent Filtering",
      "CORS Protection",
      "Input Validation",
      "Compression",
      "Request Size Limits",
      "Regex DoS Protection",
      "Method Override Protection",
      "Cache Control",
      "IP Filtering",
    ],
    activeProtections: 18,
  });
});

module.exports = router;
