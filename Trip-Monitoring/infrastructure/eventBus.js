const { connectRedis } = require("../config/redis");
const { logger } = require("../monitoring/metrics");

class EventBus {
  constructor() {
    this.redisClient = null;
    this.redisConnected = false;
    this.messagesSent = 0;
    this.subscriptions = new Set();
    this.connectedAt = null;
  }

  async connect() {
    try {
      try {
        this.redisClient = await connectRedis();
        this.redisConnected = true;
      } catch (err) {
        this.redisConnected = false;
        logger &&
          logger.warn &&
          logger.warn(
            "EventBus: failed to connect to Redis",
            err && err.message,
          );
      }

      this.connectedAt = new Date();
      logger && logger.info("EventBus: initialized");
    } catch (err) {
      logger &&
        logger.error &&
        logger.error("EventBus: unexpected connect error", err && err.message);
      throw err;
    }
  }

  async publish(topic, data) {
    try {
      logger && logger.debug && logger.debug(`EventBus.publish (Mock): ${topic}`, data);
      this.messagesSent += 1;
      return true;
    } catch (err) {
      logger &&
        logger.error &&
        logger.error("EventBus.publish failed", err && err.message);
      throw err;
    }
  }

  async publishOrderEvent(eventType, orderData, userData = {}) {
    try {
      logger && logger.debug && logger.debug(`EventBus.publishOrderEvent (Mock): ${eventType}`, { orderData, userData });
      this.messagesSent += 1;
      return true;
    } catch (err) {
      logger &&
        logger.error &&
        logger.error("EventBus.publishOrderEvent failed", err && err.message);
      throw err;
    }
  }

  async subscribe(topic, handler) {
    try {
      logger && logger.debug && logger.debug(`EventBus.subscribe (Mock): ${topic}`);
      this.subscriptions.add(topic);
      return true;
    } catch (err) {
      logger &&
        logger.error &&
        logger.error("EventBus.subscribe failed", err && err.message);
      throw err;
    }
  }

  getMetrics() {
    return {
      redisConnected: this.redisConnected,
      messagesSent: this.messagesSent,
      subscriptions: Array.from(this.subscriptions),
      connectedAt: this.connectedAt ? this.connectedAt.toISOString() : null,
    };
  }
}

module.exports = EventBus;
