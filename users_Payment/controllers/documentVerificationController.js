const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const { getUserModel, getUserKYCModel } = require("../models/users.models");
const { logUserAction } = require("../util/auditLogger");
const { parseGCSMetadata } = require("../middlewares/gcsWebhookAuth");
const {
  generateTokenAndSend,
} = require("../middlewares/genarattokenandcookies");
const {
  RekognitionClient,
  DetectFacesCommand,
  CompareFacesCommand,
  DetectModerationLabelsCommand,
} = require("@aws-sdk/client-rekognition");
const { GoogleAuth } = require("google-auth-library");
const vision = require("@google-cloud/vision");
const sharp = require("sharp");
const { logger } = require("../monitoring/metrics");
const { sendEvent } = require("../config/kafka");

const User = getUserModel();
const UserKYC = getUserKYCModel();

const rekognition = new RekognitionClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_VISION_CREDENTIALS || "{}"),
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const visionClient = new vision.ImageAnnotatorClient({ auth });

async function fetchImageBuffer(imageUrl) {
  if (!imageUrl) return null;
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Scan image for inappropriate content using Google Vision SafeSearch
 * (Safety check for adult, violence, racy content)
 */
async function scanImageContentSafety(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);

    const request = {
      image: { content: buffer.toString("base64") },
      features: [{ type: "SAFE_SEARCH_DETECTION" }],
    };

    const [result] = await visionClient.annotateImage(request);
    const safeSearch = result.safeSearchAnnotation;

    if (!safeSearch) {
      return { safe: true, reason: "No SafeSearch data" };
    }

    const harmfulLevels = ["LIKELY", "VERY_LIKELY"];
    const issues = [];

    if (harmfulLevels.includes(safeSearch.adult)) issues.push("Adult content");
    if (harmfulLevels.includes(safeSearch.violence)) issues.push("Violence");
    if (harmfulLevels.includes(safeSearch.racy)) issues.push("Racy content");

    if (issues.length > 0) {
      return {
        safe: false,
        reason: `Inappropriate content detected: ${issues.join(", ")}`,
        safeSearch,
      };
    }

    return { safe: true, safeSearch };
  } catch (error) {
    logger.error("[CONTENT_SAFETY] Error:", error.message);
    return { safe: true, reason: `Scan warning: ${error.message}` };
  }
}

/**
 * Compress image using Sharp to save storage
 * Reduces file size by ~60-80% while maintaining quality
 */
async function compressImage(imageInput, options = {}) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);

    const {
      quality = 85,
      maxWidth = 1920,
      maxHeight = 1920,
      format = "webp",
    } = options;

    const metadata = await sharp(buffer).metadata();

    // Skip if already small enough
    if (buffer.length < 100 * 1024) { // < 100KB
      return {
        compressed: buffer,
        originalSize: buffer.length,
        compressedSize: buffer.length,
        compressionRatio: 1,
        skipped: true,
      };
    }

    let pipeline = sharp(buffer);

    // Resize if larger than max dimensions
    if (metadata.width > maxWidth || metadata.height > maxHeight) {
      pipeline = pipeline.resize(maxWidth, maxHeight, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    // Convert to WebP for best compression
    const compressed = await pipeline
      .webp({ quality })
      .toBuffer();

    const compressionRatio = (1 - compressed.length / buffer.length) * 100;

    logger.info("[COMPRESS_IMAGE] Compressed", {
      originalSize: buffer.length,
      compressedSize: compressed.length,
      ratio: `${compressionRatio.toFixed(1)}%`,
      format,
    });

    return {
      compressed,
      originalSize: buffer.length,
      compressedSize: compressed.length,
      compressionRatio,
      format,
      skipped: false,
    };
  } catch (error) {
    logger.error("[COMPRESS_IMAGE] Error:", error.message);
    // Return original on error
    const buffer = Buffer.isBuffer(imageInput) ? imageInput : await fetchImageBuffer(imageInput);
    return {
      compressed: buffer,
      originalSize: buffer.length,
      compressedSize: buffer.length,
      compressionRatio: 0,
      error: error.message,
    };
  }
}

/**
 * Validate certificate expiry from guide document
 * Extracts dates and checks if document is still valid
 */
async function validateCertificateExpiry(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);

    const request = {
      image: { content: buffer.toString("base64") },
      features: [{ type: "TEXT_DETECTION" }],
    };

    const [result] = await visionClient.annotateImage(request);
    const text = result.fullTextAnnotation?.text || "";

    // Common date patterns
    const datePatterns = [
      /(?:valid|expires?|expiry|until|thru|to)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/gi,
      /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/g,
      /(\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2})/g,
    ];

    let latestDate = null;

    for (const pattern of datePatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const dateStr = match[1] || match[0];
        const parsed = new Date(dateStr.replace(/[\/\.]/g, "-"));

        if (!isNaN(parsed.getTime())) {
          if (!latestDate || parsed > latestDate) {
            latestDate = parsed;
          }
        }
      }
    }

    if (!latestDate) {
      // If no date found, allow but flag for manual review
      return {
        valid: true,
        expiryDate: null,
        needsManualReview: true,
        reason: "No expiry date found - manual review recommended",
      };
    }

    const now = new Date();
    const isExpired = latestDate < now;
    const daysUntilExpiry = Math.ceil((latestDate - now) / (1000 * 60 * 60 * 24));

    if (isExpired) {
      return {
        valid: false,
        expiryDate: latestDate,
        reason: `Document expired on ${latestDate.toISOString().split("T")[0]}`,
      };
    }

    return {
      valid: true,
      expiryDate: latestDate,
      daysUntilExpiry,
      needsManualReview: false,
    };
  } catch (error) {
    logger.error("[CERTIFICATE_EXPIRY] Error:", error.message);
    return {
      valid: true,
      expiryDate: null,
      needsManualReview: true,
      reason: `Expiry check failed: ${error.message}`,
    };
  }
}

/**
 * Validate image integrity - check file type and format
 */
async function validateImageIntegrity(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);

    const metadata = await sharp(buffer).metadata();

    const allowedFormats = ["jpeg", "jpg", "png", "webp", "gif"];
    if (!allowedFormats.includes(metadata.format)) {
      return {
        valid: false,
        reason: `Invalid format: ${metadata.format}. Allowed: ${allowedFormats.join(", ")}`,
      };
    }

    // Check minimum dimensions for ID documents
    if (metadata.width < 300 || metadata.height < 300) {
      return {
        valid: false,
        reason: "Image too small. Minimum 300x300 pixels required",
      };
    }

    // Check maximum file size (10MB)
    if (buffer.length > 10 * 1024 * 1024) {
      return {
        valid: false,
        reason: "File too large. Maximum 10MB allowed",
      };
    }

    return {
      valid: true,
      metadata: {
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        size: buffer.length,
      },
    };
  } catch (error) {
    return {
      valid: false,
      reason: `Image validation failed: ${error.message}`,
    };
  }
}

async function detectFaceInImage(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);

    const command = new DetectFacesCommand({
      Image: { Bytes: buffer },
      Attributes: ["ALL"],
    });

    const result = await rekognition.send(command);

    if (!result.FaceDetails?.length)
      return { valid: false, reason: "No face detected" };

    const face = result.FaceDetails[0];
    const confidence = face.Confidence || 0;
    const eyesOpen = face.EyesOpen?.Value || false;

    if (confidence < 80)
      return {
        valid: false,
        reason: `Low face confidence: ${confidence.toFixed(2)}%`,
      };
    if (!eyesOpen) return { valid: false, reason: "Eyes must be open" };

    return { valid: true, qualityScore: confidence, faceDetails: face };
  } catch (error) {
    return { valid: false, reason: `Face detection error: ${error.message}` };
  }
}

async function checkFaceLiveness(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);

    const modCmd = new DetectModerationLabelsCommand({
      Image: { Bytes: buffer },
      MinConfidence: 60,
    });
    const modRes = await rekognition.send(modCmd);

    const spoofIndicators = [
      "Screen",
      "Monitor",
      "Display",
      "Printed",
      "Photo",
      "Picture",
      "Mask",
    ];
    const isSpoof = modRes.ModerationLabels?.some((l) =>
      spoofIndicators.some((i) =>
        l.Name?.toLowerCase().includes(i.toLowerCase()),
      ),
    );

    if (isSpoof)
      return {
        valid: false,
        reason: "Spoofing detected",
        livenessScore: 0,
        spoofingDetected: true,
      };

    const faceCmd = new DetectFacesCommand({
      Image: { Bytes: buffer },
      Attributes: ["ALL"],
    });
    const faceRes = await rekognition.send(faceCmd);

    if (!faceRes.FaceDetails?.length) {
      return {
        valid: false,
        reason: "No face found",
        livenessScore: 0,
        spoofingDetected: false,
      };
    }

    const face = faceRes.FaceDetails[0];
    let livenessScore = 0;

    // 1. Confidence & Basic Checks
    if (face.Confidence > 95) livenessScore += 30;
    else if (face.Confidence > 85) livenessScore += 20;

    if (face.EyesOpen?.Value && face.EyesOpen?.Confidence > 90)
      livenessScore += 20;

    // 2. Pose Analysis (Ensure looking forward)
    const { Pitch, Roll, Yaw } = face.Pose || {};
    const isFacingForward = Math.abs(Pitch || 0) < 15 && Math.abs(Roll || 0) < 15 && Math.abs(Yaw || 0) < 15;
    if (isFacingForward) livenessScore += 25;
    else return { valid: false, reason: "Face must be looking directly at camera", livenessScore: 0 };

    // 3. Quality Analysis
    if (face.Quality?.Brightness >= 40 && face.Quality?.Brightness <= 95)
      livenessScore += 15;
    if (face.Quality?.Sharpness > 70) livenessScore += 10;

    // 4. Deep Heuristics (Occlusion/Smile - natural reaction)
    // Note: Smile check is secondary but adds points for "liveness"
    if (face.Smile?.Value) livenessScore += 5;

    if (livenessScore < 85) {
      return {
        valid: false,
        reason: `Liveness score too low (${livenessScore}) - please use a clearer, direct photo.`,
        livenessScore,
        spoofingDetected: false,
        livenessConfidence: face.Confidence,
      };
    }

    return {
      valid: true,
      livenessScore,
      spoofingDetected: false,
      livenessConfidence: face.Confidence,
      pose: face.Pose
    };
  } catch (error) {
    return {
      valid: false,
      reason: `Liveness error: ${error.message}`,
      livenessScore: 0,
      spoofingDetected: false,
    };
  }
}

async function detectImageManipulation(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);
    const metadata = await sharp(buffer).metadata();
    let score = 0;
    let indicators = [];

    const software = [
      "photoshop",
      "gimp",
      "paint.net",
      "pixlr",
      "canva",
      "adobe",
    ];
    if (metadata.exif) {
      const exif = JSON.stringify(metadata.exif).toLowerCase();
      const found = software.find((s) => exif.includes(s));
      if (found) {
        score += 40;
        indicators.push(`Software detected: ${found}`);
      }
    }

    if (!metadata.exif || Object.keys(metadata.exif).length < 3) {
      score += 20;
      indicators.push("Missing EXIF");
    }

    const visionReq = {
      image: { content: buffer.toString("base64") },
      features: [{ type: "IMAGE_PROPERTIES" }],
    };
    const [visionRes] = await visionClient.annotateImage(visionReq);
    const colors =
      visionRes.imagePropertiesAnnotation?.dominantColors?.colors?.slice(0, 5);

    if (
      colors?.some(
        (c) =>
          Math.max(c.color.red || 0, c.color.blue || 0, c.color.green || 0) -
          Math.min(c.color.red || 0, c.color.blue || 0, c.color.green || 0) >
          200,
      )
    ) {
      score += 15;
      indicators.push("Unnatural saturation");
    }

    if (metadata.density && metadata.density < 72) {
      score += 10;
      indicators.push("Low density");
    }

    return {
      valid: score < 40,
      reason:
        score >= 40 ? `Manipulation likely: ${indicators.join(", ")}` : "Clean",
      manipulationScore: score,
      indicators,
    };
  } catch (error) {
    return {
      valid: true,
      reason: `Check warning: ${error.message}`,
      manipulationScore: 0,
      indicators: [],
    };
  }
}

async function extractTextFromDocument(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);
    const request = {
      image: { content: buffer.toString("base64") },
      features: [
        { type: "TEXT_DETECTION" },
        { type: "DOCUMENT_TEXT_DETECTION" },
      ],
    };

    const [result] = await visionClient.annotateImage(request);
    const text = result.fullTextAnnotation?.text;

    if (!text || text.length < 20) {
      return {
        valid: false,
        reason: "Text unclear or document content too sparse (min 20 chars)",
      };
    }

    // Structural validation instead of unreliable confidence check
    const docMarkers = [
      "identity",
      "card",
      "passport",
      "national",
      "republic",
      "بطاقة",
      "القومي",
      "شخصية",
      "جواز",
      "سفر",
    ];
    const hasMarker = docMarkers.some((m) => text.toLowerCase().includes(m));

    if (!hasMarker && text.length < 50) {
      return {
        valid: false,
        reason: "Document structure not recognized and text is too short",
      };
    }

    return { valid: true, extractedText: text };
  } catch (error) {
    return { valid: false, reason: `OCR error: ${error.message}` };
  }
}

async function compareFacesFromUrls(img1, img2) {
  try {
    const buf1 = Buffer.isBuffer(img1) ? img1 : await fetchImageBuffer(img1);
    const buf2 = Buffer.isBuffer(img2) ? img2 : await fetchImageBuffer(img2);

    const command = new CompareFacesCommand({
      SourceImage: { Bytes: buf1 },
      TargetImage: { Bytes: buf2 },
      SimilarityThreshold: 0,
    });

    const result = await rekognition.send(command);

    if (!result.FaceMatches?.length)
      return { success: false, reason: "No match", similarity: 0 };

    const similarity = result.FaceMatches[0].Similarity || 0;
    return { success: true, similarity };
  } catch (error) {
    return {
      success: false,
      reason: `Comparison error: ${error.message}`,
      similarity: 0,
    };
  }
}

async function verifyGuideDocument(imageInput) {
  try {
    const buffer = Buffer.isBuffer(imageInput)
      ? imageInput
      : await fetchImageBuffer(imageInput);
    const request = {
      image: { content: buffer.toString("base64") },
      features: [{ type: "TEXT_DETECTION" }],
    };

    const [result] = await visionClient.annotateImage(request);
    const text = result.fullTextAnnotation?.text?.toLowerCase();

    if (!text) return { valid: false, reason: "Unreadable text" };

    const keywords = [
      "guide",
      "tourism",
      "tourist",
      "license",
      "tour",
      "certificate",
    ];
    if (!keywords.some((k) => text.includes(k)))
      return { valid: false, reason: "Not a guide document" };

    return { valid: true, extractedText: result.fullTextAnnotation.text };
  } catch (error) {
    return {
      valid: false,
      reason: `Guide verification error: ${error.message}`,
    };
  }
}

function validateInternationalIdFormat(extractedText, country = "any") {
  // Load valid countries list to ensure the provided country name is recognized
  const countriesData = require("../models/countries.json");
  const isValidCountry = country !== "any" && Object.keys(countriesData).includes(country);

  // Pattern Registry - Map country names and standard formats
  const patterns = {
    // 🇪🇬 EGYPT: 14-digit National ID (encoded birth date)
    Egypt: {
      regex: /\b([23])(\d{2})(\d{2})(\d{2})\d{7}\b/,
      type: "national_id",
      validator: (match) => {
        const fullId = match[0];
        if (/^(\d)\1+$/.test(fullId))
          return { valid: false, reason: "Invalid ID (repeated digits)" };

        const century = match[1] === "2" ? 1900 : 2000;
        const year = century + parseInt(match[2]);
        const month = parseInt(match[3]);
        const day = parseInt(match[4]);

        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return { valid: true, dateOfBirth: new Date(year, month - 1, day) };
        }
        return { valid: false, reason: "Invalid birth date encoded in ID" };
      },
    },

    // 🇸🇦 Saudi Arabia: 10-digit National ID starting with 1 or 2
    "Saudi Arabia": {
      regex: /\b[12]\d{9}\b/,
      type: "national_id",
      validator: (match) => ({ valid: true }),
    },

    // 🇦🇪 UAE: Emirates ID format (784-YEAR-ID-CHECKSUM)
    "United Arab Emirates": {
      regex: /\b784-\d{4}-\d{7}-\d\b/,
      type: "national_id",
      validator: (match) => ({ valid: true }),
    },

    // 🇺🇸 USA: Social Security Number (SSN)
    "United States": {
      regex: /\b\d{3}-\d{2}-\d{4}\b/,
      type: "national_id",
      validator: (match) => ({ valid: true }),
    },

    // 🇬🇧 UK: National Insurance Number
    "United Kingdom": {
      regex: /\b[A-Z]{2}\d{6}[A-Z]\b/i,
      type: "national_id",
      validator: (match) => ({ valid: true }),
    },

    // 🌐 STANDARD: ICAO compliant Passport format
    Passport: {
      regex: /\b[A-Z0-9]{6,9}\b/i,
      type: "passport",
      validator: (match) => ({ valid: true }),
    },

    // 🛠️ GENERIC: Fallback for other national IDs
    Generic: {
      regex: /\b[A-Z0-9]{5,20}\b/i,
      type: "other",
      validator: (match) => ({ valid: true }),
    },
  };

  // 1. Try Country-Specific pattern first (e.g., "Egypt", "Saudi Arabia", etc.)
  if (patterns[country]) {
    const match = extractedText.match(patterns[country].regex);
    if (match) {
      const result = patterns[country].validator(match);
      if (result.valid) {
        return {
          valid: true,
          extractedId: match[0].toUpperCase(),
          idType: patterns[country].type,
          dateOfBirth: result.dateOfBirth || null,
        };
      }
    }
  }

  // 2. Try Standard Passport fallback
  const passportMatch = extractedText.match(patterns.Passport.regex);
  if (passportMatch) {
    return {
      valid: true,
      extractedId: passportMatch[0].toUpperCase(),
      idType: "passport",
      dateOfBirth: null,
    };
  }

  // 3. Try Generic ID fallback (only if the country name is valid or it's "any")
  if (isValidCountry || country === "any") {
    const genericMatch = extractedText.match(patterns.Generic.regex);
    if (genericMatch) {
      return {
        valid: true,
        extractedId: genericMatch[0].toUpperCase(),
        idType: "other",
        dateOfBirth: null,
      };
    }
  }

  return {
    valid: false,
    reason: `No valid ID format recognized for ${country}`,
  };
}

async function checkDuplicateId(extractedId, currentUserId) {
  // ✅ Updated to use UserKYC
  const existingKYC = await UserKYC.findOne({
    identityNumber: extractedId,
    userId: { $ne: currentUserId },
  });

  if (existingKYC) {
    return {
      isDuplicate: true,
      reason: "This ID is already registered with another account",
    };
  }

  return { isDuplicate: false };
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return null;

  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age--;
  }

  return age;
}

function verifyAge(dateOfBirth, minimumAge = 18) {
  const age = calculateAge(dateOfBirth);

  if (age === null) {
    return {
      valid: false,
      reason: "Could not determine age from document",
      age: null,
    };
  }

  if (age < minimumAge) {
    return {
      valid: false,
      reason: `User must be at least ${minimumAge} years old. Detected age: ${age}`,
      age,
    };
  }

  return { valid: true, age };
}

function calculateRiskScore(verificationResults) {
  let score = 0;
  const factors = [];

  if (verificationResults.faceSimilarity < 70) {
    score += 50;
    factors.push("Very low face similarity");
  } else if (verificationResults.faceSimilarity < 80) {
    score += 30;
    factors.push("Low face similarity");
  } else if (verificationResults.faceSimilarity < 90) {
    score += 10;
    factors.push("Moderate face similarity");
  }

  if (verificationResults.livenessScore < 80) {
    score += 20;
    factors.push("Low liveness score");
  }

  if (verificationResults.spoofingDetected) {
    score += 40;
    factors.push("Spoofing indicators detected");
  }

  if (verificationResults.selfieManipulationScore >= 40) {
    score += 40;
    factors.push("Selfie manipulation detected");
  } else if (verificationResults.selfieManipulationScore >= 20) {
    score += 15;
    factors.push("Possible selfie editing");
  }

  if (verificationResults.idCardManipulationScore >= 40) {
    score += 40;
    factors.push("ID card manipulation detected");
  } else if (verificationResults.idCardManipulationScore >= 20) {
    score += 15;
    factors.push("Possible ID card editing");
  }

  if (verificationResults.isFirstVerification) {
    score += 5;
    factors.push("First verification attempt");
  }

  score = Math.min(score, 100);

  let level;
  if (score <= 30) {
    level = "low";
  } else if (score <= 60) {
    level = "medium";
  } else {
    level = "high";
  }

  return { score, level, factors };
}

async function checkRetryLimits(userKYC) {
  const MAX_ATTEMPTS = 3;
  const LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000;

  const attempts = userKYC.kycAttempts || { count: 0, lockedUntil: null };

  if (attempts.lockedUntil && new Date() < new Date(attempts.lockedUntil)) {
    const remainingMs = new Date(attempts.lockedUntil) - new Date();
    const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
    return {
      allowed: false,
      reason: `Too many failed attempts. Please try again in ${remainingHours} hours.`,
    };
  }

  if (attempts.count >= MAX_ATTEMPTS) {
    userKYC.kycAttempts = {
      count: attempts.count,
      lastAttempt: new Date(),
      lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
    };
    await userKYC.save();

    return {
      allowed: false,
      reason:
        "Maximum verification attempts exceeded. Account locked for 24 hours.",
    };
  }

  return { allowed: true, attemptsRemaining: MAX_ATTEMPTS - attempts.count };
}

/**
 * Increment KYC attempt counter
 */
async function incrementKycAttempts(userKYC) {
  const currentCount = userKYC.kycAttempts?.count || 0;
  userKYC.kycAttempts = {
    count: currentCount + 1,
    lastAttempt: new Date(),
    lockedUntil: userKYC.kycAttempts?.lockedUntil || null,
  };
  await userKYC.save();
}

/**
 * Reset KYC attempts on successful verification
 */
async function resetKycAttempts(userKYC) {
  userKYC.kycAttempts = {
    count: 0,
    lastAttempt: null,
    lockedUntil: null,
  };
}

/**
 * @desc    Process document verification (Internal/Kafka)
 * @access  Internal
 */
async function processDocumentVerification(userKYC) {
  // ✅ Works on userKYC doc now
  const retryCheck = await checkRetryLimits(userKYC);
  if (!retryCheck.allowed) throw new Error(retryCheck.reason);

  try {
    const [selfieBuf, idBuf, guideBuf] = await Promise.all([
      fetchImageBuffer(userKYC.pendingDocuments.selfie.url),
      fetchImageBuffer(userKYC.pendingDocuments.idCard.url),
      userKYC.pendingDocuments.guideDocument?.url
        ? fetchImageBuffer(userKYC.pendingDocuments.guideDocument.url)
        : null,
    ]);

    // ========== NEW: Phase 1 - Security Validation ==========
    // Validate image integrity first (format, size, dimensions)
    const [selfieIntegrity, idIntegrity, guideIntegrity] = await Promise.all([
      validateImageIntegrity(selfieBuf),
      validateImageIntegrity(idBuf),
      guideBuf ? validateImageIntegrity(guideBuf) : { valid: true },
    ]);

    if (!selfieIntegrity.valid)
      throw new Error(`Selfie Invalid: ${selfieIntegrity.reason}`);
    if (!idIntegrity.valid)
      throw new Error(`ID Card Invalid: ${idIntegrity.reason}`);
    if (guideBuf && !guideIntegrity.valid)
      throw new Error(`Guide Doc Invalid: ${guideIntegrity.reason}`);

    // ========== NEW: Phase 2 - Content Safety Scan ==========
    // Scan all images for inappropriate content (adult/violence/racy)
    const [selfieScan, idScan, guideScan] = await Promise.all([
      scanImageContentSafety(selfieBuf),
      scanImageContentSafety(idBuf),
      guideBuf ? scanImageContentSafety(guideBuf) : { safe: true },
    ]);

    if (!selfieScan.safe) {
      // Delete unsafe image
      const { deleteFile } = require("../config/googleCloudStorage");
      await deleteFile(userKYC.pendingDocuments.selfie.fileName).catch(() => { });
      throw new Error(`Selfie Rejected: ${selfieScan.reason}`);
    }
    if (!idScan.safe) {
      const { deleteFile } = require("../config/googleCloudStorage");
      await deleteFile(userKYC.pendingDocuments.idCard.fileName).catch(() => { });
      throw new Error(`ID Card Rejected: ${idScan.reason}`);
    }
    if (guideBuf && !guideScan.safe) {
      const { deleteFile } = require("../config/googleCloudStorage");
      await deleteFile(userKYC.pendingDocuments.guideDocument.fileName).catch(() => { });
      throw new Error(`Guide Doc Rejected: ${guideScan.reason}`);
    }

    logger.info("[DOC_VERIFY] Security scans passed", { userId: userKYC.userId });

    // ========== NEW: Phase 3 - Certificate Expiry Check (for guide docs) ==========
    let certExpiryResult = { valid: true };
    if (guideBuf) {
      certExpiryResult = await validateCertificateExpiry(guideBuf);
      if (!certExpiryResult.valid) {
        throw new Error(`Guide Certificate: ${certExpiryResult.reason}`);
      }
    }

    // ========== Original Verification Logic ==========
    const [
      selfieRes,
      livenessRes,
      selfieManipRes,
      ocrRes,
      idManipRes,
      guideRes,
    ] = await Promise.all([
      detectFaceInImage(selfieBuf),
      checkFaceLiveness(selfieBuf),
      detectImageManipulation(selfieBuf),
      extractTextFromDocument(idBuf),
      detectImageManipulation(idBuf),
      guideBuf ? verifyGuideDocument(guideBuf) : { valid: true },
    ]);

    if (!selfieRes.valid) throw new Error(`Selfie: ${selfieRes.reason}`);
    if (!livenessRes.valid) throw new Error(`Liveness: ${livenessRes.reason}`);
    if (!selfieManipRes.valid)
      throw new Error(`Selfie Manip: ${selfieManipRes.reason}`);
    if (!ocrRes.valid) throw new Error(`ID OCR: ${ocrRes.reason}`);
    if (!idManipRes.valid) throw new Error(`ID Manip: ${idManipRes.reason}`);
    if (guideBuf && !guideRes.valid)
      throw new Error(`Guide Doc: ${guideRes.reason}`);

    // Need user country for validation? It's in User core.
    // We should fetch User core to get country
    const User = getUserModel();
    const userCore = await User.findById(userKYC.userId);
    if (!userCore) throw new Error("User core not found for KYC verification");

    const idValidation = validateInternationalIdFormat(
      ocrRes.extractedText,
      userCore.country,
    );
    if (!idValidation.valid)
      throw new Error(`ID Invalid: ${idValidation.reason}`);

    const [dupCheck, faceRes] = await Promise.all([
      checkDuplicateId(idValidation.extractedId, userKYC.userId),
      compareFacesFromUrls(selfieBuf, idBuf),
    ]);

    if (dupCheck.isDuplicate) throw new Error(dupCheck.reason);
    if (!faceRes.success) throw new Error(`Face Match: ${faceRes.reason}`);
    if (faceRes.similarity < 70)
      throw new Error(`Face similarity low: ${faceRes.similarity}%`);
    // if (idValidation.extractedId !== userKYC.identityNumber) throw new Error("ID mismatch");
    // Remove strict mismatch check since identityNumber is now sparsely populated/updated here

    let ageRes = { valid: true, age: null };
    if (idValidation.dateOfBirth) {
      ageRes = verifyAge(idValidation.dateOfBirth, 18);
      if (!ageRes.valid) throw new Error(ageRes.reason);
    }

    const risk = calculateRiskScore({
      faceSimilarity: faceRes.similarity,
      livenessScore: livenessRes.livenessScore,
      spoofingDetected: livenessRes.spoofingDetected,
      selfieManipulationScore: selfieManipRes.manipulationScore,
      idCardManipulationScore: idManipRes.manipulationScore,
      isFirstVerification: !userKYC.documentation,
    });

    if (risk.level === "high")
      throw new Error(`High Risk (${risk.score}): ${risk.factors.join(", ")}`);

    // ========== NEW: Phase 4 - Compress & Persist Images ==========
    const { uploadBuffer, deleteFile } = require("../config/googleCloudStorage");

    const [selfieCompressed, idCompressed, guideCompressed] = await Promise.all([
      compressImage(selfieBuf),
      compressImage(idBuf),
      guideBuf ? compressImage(guideBuf) : null,
    ]);

    // Upload compressed versions to GCS and delete old ones
    const uploadTasks = [];
    const deleteTasks = [];

    // Selfie
    const selfieFileName = `compressed_selfie_${userKYC.userId}_${Date.now()}.webp`;
    uploadTasks.push(uploadBuffer(selfieCompressed.compressed, selfieFileName, "image/webp"));
    if (userKYC.pendingDocuments.selfie.fileName) {
      deleteTasks.push(deleteFile(userKYC.pendingDocuments.selfie.fileName).catch(() => { }));
    }

    // ID Card
    const idFileName = `compressed_id_${userKYC.userId}_${Date.now()}.webp`;
    uploadTasks.push(uploadBuffer(idCompressed.compressed, idFileName, "image/webp"));
    if (userKYC.pendingDocuments.idCard.fileName) {
      deleteTasks.push(deleteFile(userKYC.pendingDocuments.idCard.fileName).catch(() => { }));
    }

    // Guide Document
    let guideFileName = null;
    if (guideCompressed) {
      guideFileName = `compressed_guide_${userKYC.userId}_${Date.now()}.webp`;
      uploadTasks.push(uploadBuffer(guideCompressed.compressed, guideFileName, "image/webp"));
      if (userKYC.pendingDocuments.guideDocument?.fileName) {
        deleteTasks.push(deleteFile(userKYC.pendingDocuments.guideDocument.fileName).catch(() => { }));
      }
    }

    const [newSelfieUrl, newIdUrl, newGuideUrl] = await Promise.all(uploadTasks);
    await Promise.all(deleteTasks);

    // Log compression stats
    const totalOriginal = selfieCompressed.originalSize + idCompressed.originalSize +
      (guideCompressed?.originalSize || 0);
    const totalCompressed = selfieCompressed.compressedSize + idCompressed.compressedSize +
      (guideCompressed?.compressedSize || 0);
    const savedBytes = totalOriginal - totalCompressed;

    logger.info("[DOC_VERIFY] Images persisted & compressed", {
      userId: userKYC.userId,
      saved: `${(savedBytes / totalOriginal * 100).toFixed(1)}%`,
    });

    // Update UserKYC
    userCore.PersonalPhoto = [newSelfieUrl];
    await userCore.save();

    userKYC.documentPhoto = newIdUrl;
    if (newGuideUrl) userKYC.guideDocument = newGuideUrl;
    userKYC.documentation = true;

    // update identity logic
    userKYC.identityNumber = idValidation.extractedId;
    userKYC.identityType = idValidation.idType;
    if (idValidation.dateOfBirth) {
      userKYC.dateOfBirth = idValidation.dateOfBirth;
      userKYC.age = ageRes.age;
    }

    userKYC.idVerificationData = {
      extractedText: ocrRes.extractedText,
      extractedId: idValidation.extractedId,
      extractedDateOfBirth: idValidation.dateOfBirth,
      idType: idValidation.idType,
      ageAtVerification: ageRes.age,
      duplicateCheckPassed: true,
      verifiedAt: new Date(),
      faceSimilarity: faceRes.similarity,
      livenessScore: livenessRes.livenessScore,
      livenessConfidence: livenessRes.livenessConfidence,
      spoofingDetected: livenessRes.spoofingDetected,
      selfieManipulationScore: selfieManipRes.manipulationScore,
      selfieManipulationIndicators: selfieManipRes.indicators,
      idCardManipulationScore: idManipRes.manipulationScore,
      idCardManipulationIndicators: idManipRes.indicators,
      // NEW: Certificate expiry tracking
      certificateExpiryDate: certExpiryResult?.expiryDate || null,
      certificateDaysUntilExpiry: certExpiryResult?.daysUntilExpiry || null,
      certificateNeedsManualReview: certExpiryResult?.needsManualReview || false,
      // NEW: Compression stats for storage auditing
      compressionStats: {
        originalSize: totalOriginal,
        compressedSize: totalCompressed,
        savedBytes,
        savedPercent: ((savedBytes / totalOriginal) * 100).toFixed(1),
      },
    };

    userKYC.riskScore = {
      score: risk.score,
      level: risk.level,
      factors: risk.factors,
      calculatedAt: new Date(),
    };

    await resetKycAttempts(userKYC);

    userKYC.pendingDocuments = {
      selfie: { url: null, fileName: null, uploadedAt: null },
      idCard: { url: null, fileName: null, uploadedAt: null },
      guideDocument: { url: null, fileName: null, uploadedAt: null },
      sessionId: null,
      createdAt: null,
      expiresAt: null,
      verificationStatus: "completed",
    };

    await userKYC.save();

    logUserAction({
      user: userKYC.userId,
      action: "user",
      details: {
        action: "documentVerification",
        stage: "completed",
        riskScore: risk.score,
      },
    });

    return true;
  } catch (error) {
    await incrementKycAttempts(userKYC);
    throw error;
  }
}

/**
 * @desc    GCS webhook for document uploads (KYC)
 * @route   POST /api/auth/verifyDocuments/webhook
 * @access  Public (GCS signature verified)
 */
exports.gcsDocumentWebhook = asyncHandler(async (req, res) => {
  // ✅ Signature verification already done by gcsWebhookAuth middleware

  try {
    const { deleteFile } = require("../config/googleCloudStorage");
    const { parseGCSMetadata } = require("../middlewares/gcsWebhookAuth");

    // GCS Object Change Notification structure
    const notification = req.body;
    const fileName = notification.name;
    const eventType = notification.eventType || notification.kind;

    // Only process finalize events
    if (eventType !== "OBJECT_FINALIZE" && eventType !== "storage#object") {
      return res.status(200).json({ status: "ignored" });
    }

    const metadata = parseGCSMetadata(notification);
    const { userId, uploadType, sessionId } = metadata;

    if (!userId || !uploadType) {
      await deleteFile(fileName);
      return res.status(200).json({ status: "ignored_no_context" });
    }

    const validTypes = ["selfie", "idCard", "guideDocument"];
    if (!validTypes.includes(uploadType)) {
      await deleteFile(fileName);
      return res.status(200).json({ status: "ignored_invalid_type" });
    }

    // ✅ Fetch KYC Doc
    let userKYC = await UserKYC.findOne({ userId });
    if (!userKYC) {
      // Auto-create if missing (failsafe)
      userKYC = await UserKYC.create({ userId });
    }

    if (userKYC.documentation === true) {
      logger.warn(`[DOC_WEBHOOK] User already verified: ${userId}`, { userId });
      await deleteFile(fileName).catch(() => { });
      return res.status(200).json({ status: "already_verified" });
    }

    // Webhook Idempotency: Check if this exact file was already processed or is current
    const currentDoc = userKYC.pendingDocuments?.[uploadType];
    if (currentDoc?.fileName === fileName) {
      return res.status(200).json({ status: "already_processed" });
    }

    const oldDoc = userKYC.pendingDocuments?.[uploadType];
    if (oldDoc?.fileName && oldDoc.fileName !== fileName) {
      try {
        await deleteFile(oldDoc.fileName);
      } catch (cleanupErr) {
        logger.warn(`[DOC_WEBHOOK] Cleanup failed:`, cleanupErr.message);
      }
    }

    if (!userKYC.pendingDocuments || !userKYC.pendingDocuments.sessionId) {
      userKYC.pendingDocuments = {
        selfie: { url: null, fileName: null, uploadedAt: null },
        idCard: { url: null, fileName: null, uploadedAt: null },
        guideDocument: { url: null, fileName: null, uploadedAt: null },
        sessionId: sessionId || crypto.randomUUID(),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        verificationStatus: "pending",
      };
    }

    // Generate public URL
    const fileUrl = `https://storage.googleapis.com/${notification.bucket}/${fileName}`;

    userKYC.pendingDocuments[uploadType] = {
      url: fileUrl,
      fileName: fileName,
      uploadedAt: new Date(),
    };
    userKYC.pendingDocuments.expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await userKYC.save();

    const hasSelfie = !!userKYC.pendingDocuments.selfie?.url;
    const hasIdCard = !!userKYC.pendingDocuments.idCard?.url;
    const hasGuideDocument = !!userKYC.pendingDocuments.guideDocument?.url;

    // Fetch user role to determine required documents
    const userCore = await User.findById(userId).select('role').lean();
    const isGuide = userCore?.role === 'guide';

    // Guides need all 3 docs; Tourists only need selfie + idCard
    const allDocsReady = isGuide
      ? hasSelfie && hasIdCard && hasGuideDocument
      : hasSelfie && hasIdCard;

    if (allDocsReady) {
      userKYC.pendingDocuments.verificationStatus = "processing";
      await userKYC.save();

      try {
        await sendEvent("document-verification", {
          userId: userId,
          sessionId: userKYC.pendingDocuments.sessionId,
          selfieUrl: userKYC.pendingDocuments.selfie.url,
          idCardUrl: userKYC.pendingDocuments.idCard.url,
          guideDocumentUrl: userKYC.pendingDocuments.guideDocument?.url || null,
          timestamp: new Date(),
        });
      } catch (kafkaError) {
        logger.error(
          "[DOC_WEBHOOK] Kafka failed, using sync fallback:",
          kafkaError.message,
        );

        try {
          await processDocumentVerification(userKYC);
        } catch (verifyError) {
          logger.error(
            "[DOC_WEBHOOK] Sync verification failed:",
            verifyError.message,
          );
          userKYC.pendingDocuments.verificationStatus = "failed";
          await userKYC.save();
        }
      }
    }

    res.status(200).json({
      status: "accepted",
      documentType: uploadType,
      docsReceived: {
        selfie: hasSelfie,
        idCard: hasIdCard,
        guideDocument: hasGuideDocument,
      },
      verificationTriggered: allDocsReady,
      awaitingGuideDocument: isGuide && !hasGuideDocument,
    });
  } catch (error) {
    logger.error("[DOC_WEBHOOK] Error:", error);

    if (req.body?.name) {
      try {
        const { deleteFile } = require("../config/googleCloudStorage");
        await deleteFile(req.body.name);
      } catch (cleanupError) {
        logger.error("[DOC_WEBHOOK] Cleanup failed:", cleanupError);
      }
    }

    res.status(500).json({ error: "Webhook processing failed" });
  }
});



/**
 * @desc    Get document verification status and refresh token
 * @route   GET /api/users/verifyDocuments/status
 * @access  Private
 */
exports.getVerificationStatus = asyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const userKYC = await UserKYC.findOne({ userId: req.user._id });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Capture the latest documentation status to include in the token payload
    const userDataForToken = user.toObject();
    userDataForToken.documentation = userKYC ? userKYC.documentation : false;

    // Refresh token and send along with the response
    // This allows the mobile app to sync its header/token automatically
    generateTokenAndSend(userDataForToken, res, {
      emailVerified: user.email.verified,
      documentationComplete: userDataForToken.documentation,
      pendingDocuments: userKYC?.pendingDocuments
        ? {
          selfie: !!userKYC.pendingDocuments.selfie?.url,
          idCard: !!userKYC.pendingDocuments.idCard?.url,
          guideDocument: !!userKYC.pendingDocuments.guideDocument?.url,
          status: userKYC.pendingDocuments.verificationStatus,
          expiresAt: userKYC.pendingDocuments.expiresAt,
        }
        : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

exports.processDocumentVerification = processDocumentVerification;
