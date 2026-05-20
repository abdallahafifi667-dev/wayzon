const { Storage } = require("@google-cloud/storage");
require("dotenv").config();

// Initialize Google Cloud Storage
let storage;
let bucket;

try {
  // Option 1: Using service account key file path
  if (process.env.GCS_SERVICE_ACCOUNT_KEY_PATH) {
    storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      keyFilename: process.env.GCS_SERVICE_ACCOUNT_KEY_PATH,
    });
  }
  // Option 2: Using service account key JSON string
  else if (process.env.GCS_SERVICE_ACCOUNT_KEY) {
    const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY);
    storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: credentials,
    });
  }
  // Option 3: Using default credentials (for GCP environments)
  else {
    storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
    });
  }

  // Get bucket reference
  bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

  console.log(
    `✅ Google Cloud Storage initialized: ${process.env.GCS_BUCKET_NAME}`,
  );
} catch (error) {
  console.error("❌ Failed to initialize Google Cloud Storage:", error.message);
  // Don't throw error to allow server to start, but storage operations will fail
}

/**
 * Generate a signed URL for file upload
 * @param {string} fileName - The name/path of the file in the bucket
 * @param {object} metadata - Custom metadata to attach to the file
 * @param {string} contentType - MIME type of the file
 * @param {number} expiresInMinutes - How long the URL should be valid (default: 15 minutes)
 * @returns {Promise<string>} - The signed URL
 */
async function generateSignedUploadUrl(
  fileName,
  metadata = {},
  contentType = "application/octet-stream",
  expiresInMinutes = 15,
) {
  if (!bucket) {
    throw new Error("GCS bucket not initialized");
  }

  const file = bucket.file(fileName);

  const options = {
    version: "v4",
    action: "write",
    expires: Date.now() + expiresInMinutes * 60 * 1000,
    contentType: contentType,
    extensionHeaders: {
      "x-goog-meta-userId": metadata.userId || "",
      "x-goog-meta-uploadType": metadata.uploadType || "",
      "x-goog-meta-languageName": metadata.languageName || "",
      "x-goog-meta-sessionId": metadata.sessionId || "",
    },
  };

  const [url] = await file.getSignedUrl(options);
  return url;
}

/**
 * Generate a signed URL for file download/read
 * @param {string} fileName - The name/path of the file in the bucket
 * @param {number} expiresInMinutes - How long the URL should be valid (default: 60 minutes)
 * @returns {Promise<string>} - The signed URL
 */
async function generateSignedDownloadUrl(fileName, expiresInMinutes = 60) {
  if (!bucket) {
    throw new Error("GCS bucket not initialized");
  }

  const file = bucket.file(fileName);

  const options = {
    version: "v4",
    action: "read",
    expires: Date.now() + expiresInMinutes * 60 * 1000,
  };

  const [url] = await file.getSignedUrl(options);
  return url;
}

/**
 * Delete a file from GCS
 * @param {string} fileName - The name/path of the file in the bucket
 * @returns {Promise<void>}
 */
async function deleteFile(fileName) {
  if (!bucket) {
    throw new Error("GCS bucket not initialized");
  }

  const file = bucket.file(fileName);
  await file.delete();
}

/**
 * Get file metadata
 * @param {string} fileName - The name/path of the file in the bucket
 * @returns {Promise<object>} - File metadata
 */
async function getFileMetadata(fileName) {
  if (!bucket) {
    throw new Error("GCS bucket not initialized");
  }

  const file = bucket.file(fileName);
  const [metadata] = await file.getMetadata();
  return metadata;
}

/**
 * Upload a Buffer directly to GCS
 * @param {Buffer} buffer - The image buffer to upload
 * @param {string} fileName - The destination filename/path
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} - Public URL
 */
async function uploadBuffer(buffer, fileName, contentType = "image/webp") {
  if (!bucket) {
    throw new Error("GCS bucket not initialized");
  }

  const file = bucket.file(fileName);
  await file.save(buffer, {
    contentType,
    resumable: false,
    public: true,
  });

  return `https://storage.googleapis.com/${process.env.GCS_BUCKET_NAME}/${fileName}`;
}

/**
 * Make a file publicly accessible
 * @param {string} fileName - The name/path of the file in the bucket
 * @returns {Promise<string>} - Public URL
 */
async function makeFilePublic(fileName) {
  if (!bucket) {
    throw new Error("GCS bucket not initialized");
  }

  const file = bucket.file(fileName);
  await file.makePublic();

  return `https://storage.googleapis.com/${process.env.GCS_BUCKET_NAME}/${fileName}`;
}

module.exports = {
  storage,
  bucket,
  generateSignedUploadUrl,
  generateSignedDownloadUrl,
  deleteFile,
  getFileMetadata,
  makeFilePublic,
  uploadBuffer,
};
