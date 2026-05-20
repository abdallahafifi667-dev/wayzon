/**
 * Circuit Breaker - حماية عند فشل الخدمات الخارجية
 *
 * يمنع الاستمرار في استدعاء خدمات معطلة
 * ويوفر fallback تلقائي
 */

const { logger } = require("../monitoring/metrics");

// Circuit states
const STATES = {
  CLOSED: "closed", // Normal operation
  OPEN: "open", // Failing, reject calls
  HALF_OPEN: "half-open", // Testing if service recovered
};

// Default configuration
const DEFAULT_CONFIG = {
  failureThreshold: 5, // Failures to trip breaker
  successThreshold: 2, // Successes to close from half-open
  timeout: 30000, // Time in OPEN before trying HALF_OPEN
  resetTimeout: 60000, // Time to fully reset failure count
  monitorInterval: 5000, // Health check interval
};

class CircuitBreaker {
  constructor(name, config = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.lastStateChange = Date.now();
    this.totalCalls = 0;
    this.totalFailures = 0;
    this.fallback = config.fallback || null;
  }

  /**
   * Execute function through circuit breaker
   * @param {Function} fn - Async function to execute
   * @param {...any} args - Arguments to pass
   * @returns {any} Result or fallback
   */
  async execute(fn, ...args) {
    this.totalCalls++;

    // Check if should try half-open
    if (this.state === STATES.OPEN) {
      const timeSinceOpen = Date.now() - this.lastStateChange;
      if (timeSinceOpen >= this.config.timeout) {
        this._setState(STATES.HALF_OPEN);
      } else {
        return this._handleOpen();
      }
    }

    try {
      const result = await fn(...args);
      this._recordSuccess();
      return result;
    } catch (error) {
      this._recordFailure(error);
      throw error;
    }
  }

  /**
   * Wrap a function with circuit breaker
   * @param {Function} fn - Function to wrap
   * @returns {Function} Wrapped function
   */
  wrap(fn) {
    return async (...args) => {
      return this.execute(fn, ...args);
    };
  }

  /**
   * Handle call when circuit is open
   */
  _handleOpen() {
    logger.debug(`Circuit ${this.name} is OPEN, rejecting call`);

    if (this.fallback) {
      return this.fallback();
    }

    throw new CircuitBreakerError(
      `Circuit breaker ${this.name} is OPEN`,
      this.name,
      this.getStats(),
    );
  }

  /**
   * Record successful call
   */
  _recordSuccess() {
    this.failures = 0;
    this.successes++;

    if (this.state === STATES.HALF_OPEN) {
      if (this.successes >= this.config.successThreshold) {
        this._setState(STATES.CLOSED);
        logger.info(`Circuit ${this.name} CLOSED after recovery`);
      }
    }
  }

  /**
   * Record failed call
   */
  _recordFailure(error) {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    logger.debug(`Circuit ${this.name} failure #${this.failures}`, {
      error: error.message,
    });

    if (this.state === STATES.HALF_OPEN) {
      this._setState(STATES.OPEN);
      logger.warn(`Circuit ${this.name} re-OPENED after half-open failure`);
    } else if (this.failures >= this.config.failureThreshold) {
      this._setState(STATES.OPEN);
      logger.warn(
        `Circuit ${this.name} OPENED after ${this.failures} failures`,
      );
    }
  }

  /**
   * Set circuit state
   */
  _setState(newState) {
    this.state = newState;
    this.lastStateChange = Date.now();

    if (newState === STATES.CLOSED) {
      this.failures = 0;
      this.successes = 0;
    } else if (newState === STATES.HALF_OPEN) {
      this.successes = 0;
    }
  }

  /**
   * Get circuit statistics
   */
  getStats() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      successRate:
        this.totalCalls > 0
          ? Math.round((1 - this.totalFailures / this.totalCalls) * 100)
          : 100,
      lastFailureTime: this.lastFailureTime,
      timeSinceStateChange: Date.now() - this.lastStateChange,
    };
  }

  /**
   * Manually reset circuit
   */
  reset() {
    this._setState(STATES.CLOSED);
    this.failures = 0;
    this.successes = 0;
    logger.info(`Circuit ${this.name} manually reset`);
  }

  /**
   * Force open (for maintenance)
   */
  forceOpen() {
    this._setState(STATES.OPEN);
    logger.info(`Circuit ${this.name} force opened`);
  }

  /**
   * Check if circuit allows calls
   */
  isAllowed() {
    if (this.state === STATES.CLOSED) return true;
    if (this.state === STATES.OPEN) {
      const timeSinceOpen = Date.now() - this.lastStateChange;
      return timeSinceOpen >= this.config.timeout;
    }
    return true; // HALF_OPEN allows test calls
  }
}

class CircuitBreakerError extends Error {
  constructor(message, circuitName, stats) {
    super(message);
    this.name = "CircuitBreakerError";
    this.circuitName = circuitName;
    this.stats = stats;
  }
}

// Circuit breaker registry
const circuits = new Map();

/**
 * Get or create a circuit breaker
 * @param {string} name - Circuit name
 * @param {Object} config - Configuration
 * @returns {CircuitBreaker}
 */
function getCircuitBreaker(name, config = {}) {
  if (!circuits.has(name)) {
    circuits.set(name, new CircuitBreaker(name, config));
  }
  return circuits.get(name);
}

/**
 * Get all circuit statistics
 */
function getAllStats() {
  const stats = {};
  for (const [name, circuit] of circuits.entries()) {
    stats[name] = circuit.getStats();
  }
  return stats;
}

/**
 * Reset all circuits
 */
function resetAll() {
  for (const circuit of circuits.values()) {
    circuit.reset();
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerError,
  getCircuitBreaker,
  getAllStats,
  resetAll,
  STATES,
};
