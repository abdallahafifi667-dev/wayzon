/**
 * Shared axios instance for Python ML Brain — one pool, one timeout, one retry policy.
 * Used by index.js (MLBrainClient) and MotionTrajectoryBrain.js.
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const { logger } = require("../../monitoring/metrics");

const ML_BRAIN_URL = process.env.ML_BRAIN_URL || "http://ml-brain:8000";
const TIMEOUT_MS = Number.parseInt(process.env.ML_BRAIN_TIMEOUT, 10);
const TIMEOUT = Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0 ? TIMEOUT_MS : 5000;

if (process.env.ML_BRAIN_DEBUG === "1") {
  logger.debug("ML Brain HTTP client", { baseURL: ML_BRAIN_URL, timeout: TIMEOUT });
}

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

const client = axios.create({
  baseURL: ML_BRAIN_URL,
  timeout: TIMEOUT,
  headers: { "Content-Type": "application/json" },
  httpAgent,
  httpsAgent,
});

client.interceptors.response.use(null, async (error) => {
  const cfg = error.config;
  if (!cfg || cfg._retry >= 2) {
    return Promise.reject(error);
  }
  cfg._retry = (cfg._retry || 0) + 1;
  const backoffMs = Math.min(1000 * 2 ** cfg._retry, 5000);
  await new Promise((r) => setTimeout(r, backoffMs));
  return client(cfg);
});

module.exports = {
  mlBrainHttpClient: client,
  ML_BRAIN_URL,
  ML_BRAIN_TIMEOUT_MS: TIMEOUT,
};
