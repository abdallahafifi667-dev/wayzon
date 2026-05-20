const admin = require("firebase-admin");
const { logUserAction } = require("../util/auditLogger");
const { logger } = require("../monitoring/metrics");

// Load and parse private key safely
let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";

if (!privateKey) {
  logger.warn(
    "Firebase private key is missing or empty. Firebase notifications will be disabled.",
    {
      error:
        "Firebase private key is missing or empty. Firebase notifications will be disabled.",
    },
  );
  module.exports = null;
  return;
}

// Remove surrounding quotes if present
if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
  privateKey = privateKey.slice(1, -1);
}

// Replace escaped newlines with actual newlines
privateKey = privateKey.replace(/\\n/g, "\n");

// Validate other required fields
const requiredFields = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_CLIENT_ID",
  "FIREBASE_AUTH_URI",
  "FIREBASE_TOKEN_URI",
  "FIREBASE_PROVIDER_CERT_URL",
  "FIREBASE_CLIENT_CERT_URL",
];

const missingFields = requiredFields.filter((field) => !process.env[field]);
if (missingFields.length > 0) {
  logger.error(
    `   Available: project_id=${process.env.FIREBASE_PROJECT_ID}, private_key=${privateKey ? "YES" : "NO"}`,
    {
      error: `   Available: project_id=${process.env.FIREBASE_PROJECT_ID}, private_key=${privateKey ? "YES" : "NO"}`,
    },
  );
  module.exports = null;
  return;
}

const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: privateKey,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

try {
  // Check if already initialized
  try {
    admin.app();
  } catch (e) {
    // Not initialized yet, initialize it
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
} catch (err) {
  logUserAction({
    user: "system",
    ip: "system",
    action: "firebase",
    details: {
      action: "firebase_init_error",
      subject: "firebase_init_error",
      error: err.message,
      timestamp: new Date().toISOString(),
    },
  });
}

module.exports = admin;
