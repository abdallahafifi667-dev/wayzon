/**
 * Retry Mechanism - آلية إعادة المحاولة
 *
 * يوفر إعادة محاولة ذكية مع exponential backoff
 * للاستدعاءات الخارجية الفاشلة
 */

const { logger } = require("../monitoring/metrics");

// Default configuration
const DEFAULT_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  backoffFactor: 2, // Exponential multiplier
  jitterFactor: 0.2, // Random jitter ±20%
  retryableErrors: null, // Array of error codes to retry, null = retry all
  nonRetryableErrors: [400, 401, 403, 404], // Don't retry these
};

/**
 * Calculate delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-based)
 * @param {Object} config - Retry configuration
 * @returns {number} Delay in milliseconds
 */
function calculateDelay(attempt, config) {
  const baseDelay =
    config.initialDelay * Math.pow(config.backoffFactor, attempt);
  const cappedDelay = Math.min(baseDelay, config.maxDelay);

  // Add jitter
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = (Math.random() - 0.5) * 2 * jitterRange;

  return Math.round(cappedDelay + jitter);
}

/**
 * Check if error should be retried
 * @param {Error} error - The error
 * @param {Object} config - Retry configuration
 * @returns {boolean}
 */
function shouldRetry(error, config) {
  const statusCode = error.status || error.statusCode || error.code;

  // Check non-retryable
  if (config.nonRetryableErrors?.includes(statusCode)) {
    return false;
  }

  // Check retryable whitelist
  if (config.retryableErrors) {
    return config.retryableErrors.includes(statusCode);
  }

  // By default, retry network/server errors
  return !statusCode || statusCode >= 500 || statusCode === 429;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {any} Result of successful call
 */
async function retry(fn, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we can retry
      if (attempt >= config.maxRetries || !shouldRetry(error, config)) {
        break;
      }

      const delay = calculateDelay(attempt, config);

      logger.debug(`Retry attempt ${attempt + 1}/${config.maxRetries}`, {
        delay,
        error: error.message,
      });

      await sleep(delay);
    }
  }

  throw new RetryExhaustedError(
    `All ${config.maxRetries} retries exhausted`,
    lastError,
    config.maxRetries,
  );
}

/**
 * Create a retryable version of a function
 * @param {Function} fn - Function to wrap
 * @param {Object} options - Retry options
 * @returns {Function} Wrapped function
 */
function withRetry(fn, options = {}) {
  return async (...args) => {
    return retry(() => fn(...args), options);
  };
}

/**
 * Retry with custom condition
 * @param {Function} fn - Async function
 * @param {Function} condition - Function that returns true if should retry
 * @param {Object} options - Options
 */
async function retryWhile(fn, condition, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();

      // Check if result satisfies condition to stop
      if (!condition(result)) {
        return result;
      }

      if (attempt >= config.maxRetries) {
        throw new RetryConditionError(
          "Retry condition never satisfied",
          result,
        );
      }

      const delay = calculateDelay(attempt, config);
      await sleep(delay);
    } catch (error) {
      if (error instanceof RetryConditionError) throw error;

      if (attempt >= config.maxRetries || !shouldRetry(error, config)) {
        throw error;
      }

      const delay = calculateDelay(attempt, config);
      await sleep(delay);
    }
  }
}

class RetryExhaustedError extends Error {
  constructor(message, lastError, attempts) {
    super(message);
    this.name = "RetryExhaustedError";
    this.lastError = lastError;
    this.attempts = attempts;
  }
}

class RetryConditionError extends Error {
  constructor(message, lastResult) {
    super(message);
    this.name = "RetryConditionError";
    this.lastResult = lastResult;
  }
}

/**
 * Helper for common retry scenarios
 */
const retryPresets = {
  // For API calls - quick retries
  api: {
    maxRetries: 3,
    initialDelay: 500,
    maxDelay: 5000,
    backoffFactor: 2,
  },

  // For database operations
  database: {
    maxRetries: 5,
    initialDelay: 100,
    maxDelay: 10000,
    backoffFactor: 2,
  },

  // For rate-limited services
  rateLimited: {
    maxRetries: 5,
    initialDelay: 5000,
    maxDelay: 60000,
    backoffFactor: 2.5,
    retryableErrors: [429],
  },

  // For network issues
  network: {
    maxRetries: 4,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffFactor: 2,
    nonRetryableErrors: [], // Retry everything
  },
};

module.exports = {
  retry,
  withRetry,
  retryWhile,
  calculateDelay,
  shouldRetry,
  RetryExhaustedError,
  RetryConditionError,
  retryPresets,
  DEFAULT_CONFIG,
};
