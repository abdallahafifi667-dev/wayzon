const prometheus = require("prom-client");
const { logUserAction } = require("../util/auditLogger");

// ==================== LOGGER USING logUserAction ====================
const makeLogger = (serviceName = "trip-monitoring") => {
  const formatMeta = (meta) => {
    if (!meta) return {};
    if (typeof meta === "object") return meta;
    return { message: String(meta) };
  };

  const loggerObj = {
    info: (message, meta) => {
      console.log(`[INFO] ${message}`, meta || "");
      logUserAction({
        user: "system",
        action: "monitoring",
        details: {
          level: "info",
          service: serviceName,
          message,
          ...formatMeta(meta),
        },
      });
    },
    warn: (message, meta) => {
      console.warn(`[WARN] ${message}`, meta || "");
      logUserAction({
        user: "system",
        action: "monitoring",
        details: {
          level: "warn",
          service: serviceName,
          message,
          ...formatMeta(meta),
        },
      });
    },
    error: (message, meta) => {
      console.error(`[ERROR] ${message}`, meta || "");
      logUserAction({
        user: "system",
        action: "monitoring",
        details: {
          level: "error",
          service: serviceName,
          message,
          ...formatMeta(meta),
        },
      });
    },
    debug: (message, meta) => {
      console.debug(`[DEBUG] ${message}`, meta || "");
      logUserAction({
        user: "system",
        action: "monitoring",
        details: {
          level: "debug",
          service: serviceName,
          message,
          ...formatMeta(meta),
        },
      });
    },
  };

  loggerObj.log = loggerObj.info;
  return loggerObj;
};

const logger = makeLogger("trip-monitoring");

// ==================== PROMETHEUS METRICS ====================

// Counter: trips started
const tripsStartedCounter = new prometheus.Counter({
  name: "trip_monitoring_trips_started_total",
  help: "Total number of trips started",
  labelNames: ["location", "guide_id"],
});

// Counter: trips completed
const tripsCompletedCounter = new prometheus.Counter({
  name: "trip_monitoring_trips_completed_total",
  help: "Total number of trips completed",
  labelNames: ["location", "duration_minutes"],
});

// Counter: trips cancelled
const tripsCancelledCounter = new prometheus.Counter({
  name: "trip_monitoring_trips_cancelled_total",
  help: "Total number of trips cancelled",
  labelNames: ["reason"],
});

// Gauge: active trips
const activeTripsGauge = new prometheus.Gauge({
  name: "trip_monitoring_active_trips",
  help: "Number of currently active trips",
  labelNames: ["location"],
});

// Counter: reassurance checks sent
const reassuranceChecksSentCounter = new prometheus.Counter({
  name: "trip_monitoring_reassurance_checks_sent_total",
  help: "Total reassurance checks sent",
  labelNames: ["check_number"],
});

// Counter: reassurance responses
const reassuranceResponsesCounter = new prometheus.Counter({
  name: "trip_monitoring_reassurance_responses_total",
  help: "Total reassurance responses received",
  labelNames: ["response_type"], // 'yes', 'no', 'timeout'
});

// Counter: violations detected
const violationsDetectedCounter = new prometheus.Counter({
  name: "trip_monitoring_violations_detected_total",
  help: "Total violations detected during trips",
  labelNames: ["violation_type"], // 'ROUTE_DEVIATION', 'TIME_VIOLATION', 'GUIDE_REMOVED'
});

// Counter: police alerts
const policeAlertsCounter = new prometheus.Counter({
  name: "trip_monitoring_police_alerts_total",
  help: "Total police alerts triggered",
  labelNames: ["escalation_level", "country"],
});

// Histogram: trip duration
const tripDurationHistogram = new prometheus.Histogram({
  name: "trip_monitoring_trip_duration_minutes",
  help: "Trip duration in minutes",
  buckets: [15, 30, 45, 60, 90, 120, 180],
});

// Histogram: location update latency
const locationUpdateLatencyHistogram = new prometheus.Histogram({
  name: "trip_monitoring_location_update_latency_ms",
  help: "Location update latency in milliseconds",
  buckets: [100, 500, 1000, 2000, 5000],
});


// Gauge: redis connection status
const redisConnectionGauge = new prometheus.Gauge({
  name: "trip_monitoring_redis_connected",
  help: "Redis connection status (1=connected, 0=disconnected)",
});


// Histogram: HTTP request duration
const httpRequestDurationHistogram = new prometheus.Histogram({
  name: "trip_monitoring_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.5, 1, 2, 5],
});

// Counter: HTTP requests total
const httpRequestsTotalCounter = new prometheus.Counter({
  name: "trip_monitoring_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

// Counter: Scheduler runs
const schedulerRunsCounter = new prometheus.Counter({
  name: "trip_monitoring_scheduler_runs_total",
  help: "Total number of scheduler execution runs",
});

// Counter: Scheduler trips processed
const schedulerTripsProcessedCounter = new prometheus.Counter({
  name: "trip_monitoring_scheduler_trips_processed_total",
  help: "Total number of trips processed by scheduler",
});

// Counter: Scheduler errors
const schedulerErrorsCounter = new prometheus.Counter({
  name: "trip_monitoring_scheduler_errors_total",
  help: "Total number of errors in scheduler",
});

// ==================== METRICS REGISTRY ====================

const register = new prometheus.Registry();
prometheus.collectDefaultMetrics({ register });

// Register custom metrics
[
  tripsStartedCounter,
  tripsCompletedCounter,
  tripsCancelledCounter,
  activeTripsGauge,
  reassuranceChecksSentCounter,
  reassuranceResponsesCounter,
  violationsDetectedCounter,
  policeAlertsCounter,
  tripDurationHistogram,
  locationUpdateLatencyHistogram,
  redisConnectionGauge,
  httpRequestDurationHistogram,
  httpRequestsTotalCounter,
  schedulerRunsCounter,
  schedulerTripsProcessedCounter,
  schedulerErrorsCounter,
].forEach((m) => register.registerMetric(m));

// ==================== METRICS HELPER CLASS ====================

class MetricsCollector {
  /**
   * Record trip start
   */
  static recordTripStart(location, guideId) {
    tripsStartedCounter.inc({ location, guide_id: guideId });
    logger.info("Trip started", { location, guideId });
  }

  /**
   * Record trip completion
   */
  static recordTripCompletion(location, durationMinutes) {
    tripsCompletedCounter.inc({
      location,
      duration_minutes: Math.ceil(durationMinutes),
    });
    tripDurationHistogram.observe(durationMinutes);
    logger.info("Trip completed", { location, durationMinutes });
  }

  /**
   * Record trip cancellation
   */
  static recordTripCancellation(reason) {
    tripsCancelledCounter.inc({ reason });
    logger.warn("Trip cancelled", { reason });
  }

  /**
   * Update active trips gauge
   */
  static updateActiveTrips(count, location = "all") {
    activeTripsGauge.set({ location }, count);
  }

  /**
   * Record reassurance check sent
   */
  static recordReassuranceCheckSent(checkNumber) {
    reassuranceChecksSentCounter.inc({ check_number: checkNumber });
    logger.info("Reassurance check sent", { checkNumber });
  }

  /**
   * Record reassurance response
   */
  static recordReassuranceResponse(responseType) {
    reassuranceResponsesCounter.inc({ response_type: responseType });
    logger.info("Reassurance response received", { responseType });
  }

  /**
   * Record violation detected
   */
  static recordViolation(violationType, tripId) {
    violationsDetectedCounter.inc({ violation_type: violationType });
    logger.warn("Violation detected", { violationType, tripId });
  }

  /**
   * Record police alert
   */
  static recordPoliceAlert(escalationLevel, country) {
    policeAlertsCounter.inc({ escalation_level: escalationLevel, country });
    logger.error("Police alert triggered", { escalationLevel, country });
  }


  /**
   * Update Redis connection status
   */
  static setRedisConnected(connected) {
    redisConnectionGauge.set(connected ? 1 : 0);
    if (connected) {
      logger.info("Redis connection established");
    } else {
      logger.error("Redis connection lost");
    }
  }


  /**
   * Record location update latency
   */
  static recordLocationUpdateLatency(latencyMs) {
    locationUpdateLatencyHistogram.observe(latencyMs);
    if (latencyMs > 2000) {
      logger.warn("High location update latency", { latencyMs });
    }
  }

  static recordHttpRequest(method, route, statusCode, durationSeconds) {
    httpRequestsTotalCounter.inc({ method, route, status_code: statusCode });
    httpRequestDurationHistogram.observe(
      { method, route, status_code: statusCode },
      durationSeconds,
    );
  }

  static recordSchedulerRun() {
    schedulerRunsCounter.inc();
  }

  static recordSchedulerTripProcessed() {
    schedulerTripsProcessedCounter.inc();
  }

  static recordSchedulerError() {
    schedulerErrorsCounter.inc();
  }
}

// ==================== EXPORTS ====================

module.exports = {
  logger,
  register,
  MetricsCollector,
  // Metrics for direct access if needed
  metrics: {
    tripsStartedCounter,
    tripsCompletedCounter,
    tripsCancelledCounter,
    activeTripsGauge,
    reassuranceChecksSentCounter,
    reassuranceResponsesCounter,
    violationsDetectedCounter,
    policeAlertsCounter,
    tripDurationHistogram,
    locationUpdateLatencyHistogram,
    redisConnectionGauge,
    httpRequestDurationHistogram,
    httpRequestsTotalCounter,
    schedulerRunsCounter,
    schedulerTripsProcessedCounter,
    schedulerErrorsCounter,
  },
};
