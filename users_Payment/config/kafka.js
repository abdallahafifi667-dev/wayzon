const { Kafka, logLevel } = require("kafkajs");
const { logger, MetricsCollector } = require("../monitoring/metrics");
const { logUserAction } = require("../util/auditLogger");

// Custom logCreator to filter specific noisy kafkajs messages
const kafkajsLogCreator =
  () =>
  ({ namespace, level, label, log }) => {
    try {
      const msg = log && log.message ? String(log.message) : "";
      const errText =
        log && log.error ? String(log.error.message || log.error) : "";

      // Filter out the specific SyncGroup / rebalancing message
      if (msg.includes("Response SyncGroup") || /rebalanc/i.test(errText)) {
        return; // drop this log
      }

      const meta = Object.assign(
        { namespace, label, kafkajsLevel: level },
        log || {},
      );

      // Map to your structured logger (fall back to info)
      const lvl = String(level || "").toLowerCase();
      if (lvl.includes("error") || lvl === "2") {
        logger.error(msg || "[kafkajs]", meta);
      } else if (lvl.includes("warn") || lvl === "1") {
        logger.warn(msg || "[kafkajs]", meta);
      } else {
        logger.info(msg || "[kafkajs]", meta);
      }
    } catch (e) {
      logUserAction({
        user: "system",
        ip: "system",
        action: "kafka",
        details: {
          action: "kafka_error",
          subject: "kafka_error",
          error: e.message,
          timestamp: new Date().toISOString(),
        },
      });
    }
  };

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || "travel-platform",
  brokers: process.env.KAFKA_BROKERS?.split(",") || ["localhost:9092"],
  // Tune basic timeouts and retries to be more resilient on flaky networks
  connectionTimeout: parseInt(
    process.env.KAFKA_CONNECTION_TIMEOUT_MS || "3000",
    10,
  ),
  requestTimeout: parseInt(process.env.KAFKA_REQUEST_TIMEOUT_MS || "30000", 10),
  retry: {
    initialRetryTime: parseInt(process.env.KAFKA_RETRY_INITIAL_MS || "300", 10),
    retries: parseInt(process.env.KAFKA_RETRY_ATTEMPTS || "10", 10),
  },
  // Use ERROR as base level but apply custom logCreator to filter/selectively suppress
  logLevel: logLevel.ERROR,
  logCreator: kafkajsLogCreator,
});

const producer = kafka.producer();
const consumer = kafka.consumer({
  groupId: process.env.KAFKA_CONSUMER_GROUP || "main-group",
  // sessionTimeout controls how long the broker waits for heartbeats before considering the member dead
  sessionTimeout: parseInt(process.env.KAFKA_SESSION_TIMEOUT_MS || "60000", 10),
  // rebalanceTimeout larger value helps during long rebalances/processing
  rebalanceTimeout: parseInt(
    process.env.KAFKA_REBALANCE_TIMEOUT_MS || "90000",
    10,
  ),
});

// Internal state to support subscriptions called before connect
let consumerConnected = false;
let consumerRunning = false;
const subscriptionQueue = new Set();
const subscribedTopics = new Set();
const handlers = new Map();
let resubscribeInProgress = false;

async function connectKafka() {
  await producer.connect();
  await consumer.connect();
  consumerConnected = true;

  // Subscribe any topics that were registered before connect
  for (const topic of Array.from(subscriptionQueue)) {
    try {
      await consumer.subscribe({ topic, fromBeginning: false });
      subscribedTopics.add(topic);
      subscriptionQueue.delete(topic);
    } catch (err) {
      console.error(`Failed to subscribe to queued topic ${topic}:`, err);
    }
  }

  // Start the consumer loop with a shared handler
  if (!consumerRunning) {
    await runConsumerLoop();
  }

  console.log("✅ Kafka Connected");
}

async function sendEvent(topic, data) {
  try {
    await producer.send({
      topic,
      messages: [{ value: JSON.stringify(data) }],
    });
    console.log(`✅ Event sent to topic: ${topic}`);
    MetricsCollector.recordEventPublished(topic);
  } catch (err) {
    console.error(`❌ Failed to send event to ${topic}:`, err);
    MetricsCollector.recordEventFailure(topic, "publish_error");
    throw err;
  }
}

async function subscribe(topic, callback) {
  handlers.set(topic, callback);
  if (!consumerConnected) {
    subscriptionQueue.add(topic);
    return;
  }

  // If already subscribed, nothing to do
  if (subscribedTopics.has(topic)) return;

  // If consumer isn't running yet, we can safely subscribe directly
  if (!consumerRunning) {
    try {
      await consumer.subscribe({ topic, fromBeginning: false });
      subscribedTopics.add(topic);
      return;
    } catch (err) {
      console.error(`Failed to subscribe to Kafka topic ${topic}:`, err);
      throw err;
    }
  }

  // Consumer is running: queue the topic and schedule a coordinated resubscribe
  subscriptionQueue.add(topic);
  scheduleResubscribe();
}

// Extracted consumer run logic so it can be restarted safely
async function runConsumerLoop() {
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const value = JSON.parse(message.value.toString());
        const handler = handlers.get(topic);
        if (handler) {
          await handler(value);
          MetricsCollector.recordEventConsumed(topic);
        }
      } catch (err) {
        console.error("Kafka message error:", err);
        MetricsCollector.recordEventFailure(topic, "consumption_error");
      }
    },
  });
  consumerRunning = true;
}

async function scheduleResubscribe() {
  if (resubscribeInProgress) return;
  resubscribeInProgress = true;

  (async () => {
    try {
      // stop the consumer to allow new subscriptions
      if (consumerRunning) {
        await consumer.stop();
        consumerRunning = false;
      }

      // subscribe to any queued topics
      for (const topic of Array.from(subscriptionQueue)) {
        if (subscribedTopics.has(topic)) {
          subscriptionQueue.delete(topic);
          continue;
        }
        try {
          await consumer.subscribe({ topic, fromBeginning: false });
          subscribedTopics.add(topic);
          subscriptionQueue.delete(topic);
        } catch (err) {
          console.error(`Failed to subscribe to queued topic ${topic}:`, err);
        }
      }

      // restart the consumer loop
      await runConsumerLoop();
    } catch (err) {
      console.error("Error during resubscribe process:", err);
    } finally {
      resubscribeInProgress = false;
    }
  })();
}

// دالة مساعدة لإرسال الأحداث مع metadata
async function sendOrderEvent(eventType, orderData, userData = {}) {
  const event = {
    type: eventType,
    data: orderData,
    metadata: {
      timestamp: new Date().toISOString(),
      userId: userData.userId,
      userRole: userData.role,
      ...userData,
    },
  };

  await sendEvent("order-events", event);
}

module.exports = {
  connectKafka,
  sendEvent,
  subscribe,
  sendOrderEvent,
};
