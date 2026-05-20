const { connectRedis } = require("../config/redis");
const {
  connectKafka,
  sendEvent,
  subscribe,
  sendOrderEvent,
} = require("../config/kafka");
const { logger } = require("../monitoring/metrics");

class EventBus {
  constructor() {
    this.redisClient = null;
    this.kafkaConnected = false;
    this.redisConnected = false;
    this.messagesSent = 0;
    this.subscriptions = new Set();
    this.connectedAt = null;
  }

  async connect() {
    try {
      logger.info("EventBus: Starting connection process...");
      try {
        logger.info("EventBus: Connecting to Redis...");
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
      const maxKafkaRetries = parseInt(
        process.env.KAFKA_CONNECT_RETRIES || "6",
        10,
      );
      const kafkaRetryDelay = parseInt(
        process.env.KAFKA_CONNECT_RETRY_DELAY_MS || "3000",
        10,
      );

      logger.info("EventBus: Connecting to Kafka...", {
        maxRetries: maxKafkaRetries,
        retryDelay: kafkaRetryDelay,
      });

      let connected;
      for (let attempt = 1; attempt <= maxKafkaRetries; attempt++) {
        try {
          logger.info(`EventBus: Kafka connection attempt ${attempt}/${maxKafkaRetries}...`);
          await connectKafka();
          connected = true;
          this.kafkaConnected = true;
          logger.info("EventBus: Kafka connected successfully");
          break;
        } catch (err) {
          logger.warn(`EventBus: Kafka connection attempt ${attempt} failed: ${err.message}`);
          if (attempt < maxKafkaRetries) {
            await new Promise((r) => setTimeout(r, kafkaRetryDelay));
          }
        }
      }

      this.connectedAt = new Date();
    } catch (err) {
      logger &&
        logger.error &&
        logger.error("EventBus: unexpected connect error", err && err.message);
      throw err;
    }
  }

  async publish(topic, data) {
    try {
      if (!this.kafkaConnected) {
        logger &&
          logger.warn &&
          logger.warn(
            "EventBus.publish: kafka not connected, attempting to send",
            topic,
          );
      }
      await sendEvent(topic, data);
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
      await sendOrderEvent(eventType, orderData, userData);
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
      await subscribe(topic, handler);
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
      kafkaConnected: this.kafkaConnected,
      redisConnected: this.redisConnected,
      messagesSent: this.messagesSent,
      subscriptions: Array.from(this.subscriptions),
      connectedAt: this.connectedAt ? this.connectedAt.toISOString() : null,
    };
  }
}

module.exports = EventBus;
