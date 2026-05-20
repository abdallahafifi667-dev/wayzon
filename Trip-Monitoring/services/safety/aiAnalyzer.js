/**
 * AI Analyzer - Layer 3: Gemini AI Threat Analysis
 * Refactored for robustness, performance, and cleaner code.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getSafetyEventModel } = require("../../models/ml.model");
const { logger } = require("../../monitoring/metrics");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});

// ✅ Consecutive failure tracking (like ML Brain)
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
let lastFailureTime = null;

/**
 * Robust JSON extraction helper
 */
function safeParseJSON(text, fallback = {}) {
  try {
    // First try direct parse if model obeyed JSON mode
    return JSON.parse(text);
  } catch (e1) {
    try {
      // Fallback: extract JSON from markdown code blocks or text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      throw new Error("No valid JSON found");
    } catch (e2) {
      logger.warn("AI JSON parsing failed", {
        textSnippet: text.slice(0, 100),
      });
      return fallback;
    }
  }
}

async function analyzeContext(tripContext) {
  const safetyMode = tripContext.safetyMode || 'free';

  // Free mode: Use heuristics instead of Gemini AI
  if (safetyMode === 'free') {
    return analyzeWithHeuristics(tripContext);
  }

  // Paid mode: Use Gemini AI
  const prompt = buildPrompt(tripContext);
  const startTime = Date.now();

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const analysis = safeParseJSON(text, {
      riskLevel: "caution",
      shouldAskUser: true,
      questionToAsk: "Are you safe? We detected unusual activity.",
      questionType: "wellbeing_check",
      maxWaitTime: 60,
      shouldEscalate: false,
    });

    const finalAnalysis = {
      status: "analyzed",
      riskLevel: analysis.riskLevel || "unknown",
      confidence: analysis.confidence || 50,
      isJustified: analysis.isJustified || false,
      justification: analysis.justification,
      situation: analysis.situation,
      shouldAskUser: analysis.shouldAskUser || false,
      questionToAsk: analysis.questionToAsk,
      questionType: analysis.questionType,
      maxWaitTime: Math.min(Math.max(analysis.maxWaitTime || 60, 30), 300),
      shouldEscalate: analysis.shouldEscalate || false,
      escalationReason: analysis.escalationReason,
      recommendedActions: analysis.recommendedActions || [],
      contextFactors: analysis.contextFactors || [],
      aiCalled: true,
      responseTime: Date.now() - startTime,
    };

    // ✅ Reset consecutive failures on success
    consecutiveFailures = 0;

    await saveToDB(tripContext, finalAnalysis);
    return finalAnalysis;
  } catch (err) {
    // ✅ Increment consecutive failures
    consecutiveFailures++;
    lastFailureTime = new Date().toISOString();

    // ✅ FAIL LOUD: Log with full context
    logger.error("CRITICAL: Gemini AI Analysis failed", {
      error: err.message,
      stack: err.stack,
      tripId: tripContext.tripId,
      consecutiveFailures,
      lastFailureTime,
      timestamp: new Date().toISOString(),
    });

    // ✅ Alert after threshold
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error("CRITICAL: Gemini AI service degraded after multiple failures", {
        consecutiveFailures,
        maxThreshold: MAX_CONSECUTIVE_FAILURES,
        lastFailureTime,
        recommendation: "Check Gemini API key, quota, and service status"
      });
      // TODO: Integrate with PagerDuty/Slack alerts
    }

    // ✅ Alert admin that AI layer failed
    try {
      const { escalateToAdmin } = require("./escalationService");
      await escalateToAdmin({
        reason: "ai_layer_failure",
        details: {
          error: err.message,
          tripId: tripContext.tripId,
          consecutiveFailures,
          lastFailureTime
        },
        priority: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? "critical" : "high"
      }).catch(e => logger.warn("Failed to escalate AI failure", { error: e.message }));
    } catch (e) {
      logger.warn("Could not escalate AI failure", { error: e.message });
    }

    return {
      status: "error",
      error: err.message,
      recommendation: "escalate_to_admin",
      riskLevel: "dangerous",  // 🔴 FAIL-SAFE: Conservative assumption
      isFailSafe: true,
      shouldEscalate: true,
      escalationReason: "AI analysis failed - proceeding with caution",
      consecutiveFailures,
      lastFailureTime
    };
  }
}

/**
 * Free mode: Heuristic-based analysis (no AI)
 */
function analyzeWithHeuristics(context) {
  const { stoppedDuration = 0, mlAnalysis = {}, mapVerification = {}, distanceAnalysis = {} } = context;

  let riskLevel = 'safe';
  let confidence = 50;
  let justification = 'Basic safety check (Free mode)';
  let shouldAskUser = false;

  // Rule 1: Long stop duration
  if (stoppedDuration > 600000) { // 10 minutes
    riskLevel = 'caution';
    confidence = 60;
    justification = 'Extended stop detected. Please confirm your status.';
    shouldAskUser = true;
  }

  // Rule 2: ML flagged high risk
  if (mlAnalysis?.riskLevel === 'high' || mlAnalysis?.riskLevel === 'danger') {
    riskLevel = 'warning';
    confidence = 70;
    justification = 'Unusual pattern detected by safety system.';
    shouldAskUser = true;
  }

  // Rule 3: Distance deviation
  if (distanceAnalysis?.deviationKm > 5) {
    riskLevel = riskLevel === 'warning' ? 'warning' : 'caution';
    justification = 'Route deviation detected.';
    shouldAskUser = true;
  }

  return {
    status: 'analyzed',
    riskLevel,
    confidence,
    isJustified: true,
    justification,
    situation: `Safety check completed using basic monitoring (Free mode)`,
    shouldAskUser,
    questionToAsk: shouldAskUser ? 'Are you safe? Please confirm your status.' : null,
    questionType: 'wellbeing_check',
    maxWaitTime: 60,
    shouldEscalate: false,
    recommendedActions: [],
    contextFactors: ['heuristic_analysis', 'free_mode'],
    aiCalled: false,
    freeMode: true
  };
}

function buildPrompt(context) {
  // Safe destructuring with defaults
  const {
    role = "unknown",
    tripDetails = {},
    stoppedDuration = 0,
    tripProgress = {},
    address = "Unknown",
    reputationHistory = [],
    previousLocations = [],
    userProfile = {},
    safeAlternatives = [],
    mlAnalysis = {},
    mapVerification = {},
    distanceAnalysis = {},
  } = context || {};

  const demographics = userProfile.demographics || {};

  // Structured Context for AI
  const safetyContext = {
    trip: {
      title: tripDetails.title || "Unknown",
      country: tripDetails.destinationCountry || "Unknown",
      role: role === "guide" ? "Tour Guide" : "Tourist",
      progress: `${tripProgress.percentComplete || 0}%`,
      currentAddress: address,
      userDemographics: {
        age: demographics.age || "Unknown",
        gender: demographics.gender || "Unknown",
      },
    },
    status: {
      stoppedMinutes: stoppedDuration ? Math.round(stoppedDuration / 60000) : 0,
      locationReputation: reputationHistory.slice(-3), // Last 3 only for brevity
    },
    signals: {
      mlRisk: mlAnalysis,
      mapData: mapVerification,
      distanceData: distanceAnalysis,
    },
    recentPath: previousLocations.slice(-5).map((l) => ({
      coords: l.coordinates,
      time: new Date(l.timestamp).toISOString(),
    })),
  };

  // List safe alternatives if provided
  let alternativesSection = "";
  if (safeAlternatives?.length > 0) {
    alternativesSection = `
SAFE ALTERNATIVES NEARBY:
${safeAlternatives.map((a) => `- ${a.name} (${a.types.join(", ")}): ${a.distanceText} away, Rating: ${a.rating}`).join("\n")}
`;
  }

  const contextStr = JSON.stringify(safetyContext, null, 2);

  const prompt = `
[SYSTEM_INSTRUCTION]
You are a proactive Safety Analysis AI. Your goal is to keep the user safe during their trip.
Analyze the following context for risks (crime, environmental, behavioral).

PERSONALIZATION GUIDELINES:
- If age < 18: Be extra cautious. Prioritize family-friendly and highly supervised areas.
- If female: Prioritize well-lit, populated, and highly-rated areas. Mention "Public visibility" in justification.

REQUIRED RESPONSE FORMAT (JSON ONLY):
{
  "riskLevel": "safe" | "caution" | "warning" | "dangerous",
  "confidence": 0-100,
  "situation": "Short summary of what's happening",
  "justification": "Why this risk level? Mention user demographics if they affected the decision.",
  "isJustified": boolean,
  "shouldAskUser": boolean,
  "questionToAsk": "Personalized question to the user",
  "personalizedAlternative": "If risky, suggest a specific place from the list below that fits the user's profile",
  "recommendedActions": ["action1", "action2"]
}

${alternativesSection}

CONTEXT:
${contextStr}
`;

  return prompt;
}

async function saveToDB(context, analysis) {
  try {
    const SafetyEvent = getSafetyEventModel();
    const nearbySafe = context.mapVerification?.nearbyPlaces?.safe || [];

    await SafetyEvent.create({
      orderId: context.tripDetails?._id,
      eventType: "ai_analysis",
      participants: {
        tourist: context.tripDetails?.normal,
        guide: context.tripDetails?.guide,
      },
      context: {
        location: {
          type: "Point",
          coordinates: context.coordinates || [0, 0],
        },
        nearbyPlaces: nearbySafe.map((p) => ({
          name: p.name,
          type: p.types?.[0] || "unknown",
        })),
        safetyFactors: {
          riskLevel: analysis.riskLevel,
          environmentType: context.mapVerification?.locationType || "unknown",
        },
      },
      aiPrediction: {
        riskScore:
          analysis.riskLevel === "danger"
            ? 90
            : analysis.riskLevel === "warning"
              ? 70
              : analysis.riskLevel === "caution"
                ? 40
                : 20,
        confidence: analysis.confidence,
        recommendedActions: analysis.recommendedActions,
        recommendedQuestions: analysis.shouldAskUser
          ? [
            {
              question: analysis.questionToAsk,
              targetRecipient: "tourist",
              urgency: analysis.riskLevel,
            },
          ]
          : [],
      },
    });
  } catch (err) {
    logger.error("Failed to save AI analysis to DB", { error: err.message });
  }
}

async function generateFollowUpQuestion(previousResponse, context) {
  const prompt = `User response: "${previousResponse}"
    Context: ${JSON.stringify(context)}

Analyze if user needs help or if situation is resolved.
    Respond in JSON:
    {
        "needsFollowUp": boolean,
            "followUpQuestion": "string"(optional),
                "shouldEscalate": boolean,
                    "assessment": "string"
    } `;

  try {
    const result = await model.generateContent(prompt);
    return safeParseJSON(result.response.text(), {
      needsFollowUp: false,
      shouldEscalate: true,
      assessment: "Error analyzing response",
    });
  } catch (err) {
    return {
      needsFollowUp: false,
      shouldEscalate: true,
      assessment: "AI Service Failure",
    };
  }
}

/**
 * Phase 5: Analyze video/news metadata for active threats
 */
async function analyzeVideoMetadata(data) {
  const prompt = `Analyze search results and comments for "${data.location}, ${data.country}" to detect ACTIVE REAL - TIME safety threats(fights, accidents, riots) within the last hour.

        IMPORTANT: Verify the "TRUTH" and "RECENCY" of these videos.Look for signs of "fake news", "old footage", or "staged events" in titles / descriptions and particularly in user comments.
    
    SEARCH DATA(Includes Metadata & Comments):
    ${JSON.stringify(data.videos, null, 2)}
    
    Respond ONLY in JSON(all strings in English):
    {
        "riskLevel": "safe|warning|danger",
            "summary": "Brief explanation including your assessment of truthfulness (IN ENGLISH)",
                "isVerifiedTruth": boolean,
                    "truthConfidence": 0 - 100,
                        "detectedThreats": ["riot", "fire", "etc"],
                            "keyVideos": ["url1"]
    } `;

  try {
    const result = await model.generateContent(prompt);
    return safeParseJSON(result.response.text(), {
      riskLevel: "unknown",
      summary: "AI analysis failed",
      isVerifiedTruth: false,
      keyVideos: [],
    });
  } catch (err) {
    return {
      riskLevel: "unknown",
      summary: "AI analysis failed",
      isVerifiedTruth: false,
      keyVideos: [],
    };
  }
}

/**
 * 🆕 Phase 6: Multimodal Thumbnail Analysis
 * Sends video thumbnail images to Gemini 1.5 Flash for visual threat detection
 * This is FREE (thumbnail URLs) + cost of Gemini vision call
 * @param {string|string[]} thumbnailUrls - URL(s) of thumbnail images
 * @param {Object} context - { location, videoTitle, scanType }
 */
async function analyzeVideoThumbnail(thumbnailUrls, context = {}) {
  // Normalize to array
  const urls = Array.isArray(thumbnailUrls) ? thumbnailUrls : [thumbnailUrls];

  // Limit to 3 thumbnails to control costs
  const limitedUrls = urls.slice(0, 3);

  const prompt = `You are analyzing video thumbnail images for REAL - TIME SAFETY THREATS.Output must be IN ENGLISH ONLY.

        CONTEXT:
    - Location: ${context.location || "Unknown"}
    - Video Title: ${context.videoTitle || "Unknown"}
    - Scan Type: ${context.scanType || "live_hazard"}

ANALYZE THE IMAGE(S) FOR:
    1. Visible fire, smoke, or explosions
    2. Large crowds in panic or running
    3. Visible weapons or armed individuals
    4. Accident scenes(car crashes, injuries)
    5. Flood or natural disaster signs
    6. Any other visible danger indicators

Respond ONLY in JSON(all strings in English):
    {
        "hasVisibleDanger": boolean,
            "dangerType": "fire|crowd_panic|weapon|accident|flood|other|none",
                "confidence": 0 - 100,
                    "description": "Brief explanation of what you see (IN ENGLISH)",
                        "urgencyLevel": "low|medium|high|critical",
                            "recommendAction": "ignore|monitor|alert|escalate"
    } `;

  try {
    // Prepare image parts for multimodal input
    const imageParts = await Promise.all(
      limitedUrls.map(async (url) => {
        try {
          // Fetch image and convert to base64
          const response = await fetch(url);
          if (!response.ok) return null;

          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mimeType = response.headers.get("content-type") || "image/jpeg";

          return {
            inlineData: {
              data: base64,
              mimeType: mimeType,
            },
          };
        } catch (err) {
          logger.debug("Failed to fetch thumbnail", {
            url,
            error: err.message,
          });
          return null;
        }
      }),
    );

    // Filter out failed fetches
    const validImages = imageParts.filter((p) => p !== null);

    if (validImages.length === 0) {
      return {
        hasVisibleDanger: false,
        error: "Failed to fetch thumbnails",
        confidence: 0,
      };
    }

    // Send to Gemini with images
    const result = await model.generateContent([prompt, ...validImages]);
    const analysis = safeParseJSON(result.response.text(), {
      hasVisibleDanger: false,
      dangerType: "unknown",
      confidence: 0,
      description: "Analysis failed",
      urgencyLevel: "low",
      recommendAction: "ignore",
    });

    return {
      ...analysis,
      thumbnailsAnalyzed: validImages.length,
      analysisTimestamp: Date.now(),
    };
  } catch (err) {
    logger.error("Thumbnail analysis failed", { error: err.message });
    return {
      hasVisibleDanger: false,
      error: err.message,
      confidence: 0,
      recommendAction: "ignore",
    };
  }
}

/**
 * 🆕 General-purpose text analysis
 * Used by locationReputationService for review analysis
 */
async function analyzeText(prompt) {
  try {
    const result = await model.generateContent(prompt);
    return safeParseJSON(result.response.text(), {
      riskLevel: "low",
      summary: "Analysis completed",
      detectedRisks: [],
    });
  } catch (err) {
    logger.error("AI text analysis failed", { error: err.message });
    return {
      riskLevel: "unknown",
      summary: "AI analysis unavailable",
      detectedRisks: [],
    };
  }
}

module.exports = {
  analyzeContext,
  generateFollowUpQuestion,
  analyzeVideoMetadata,
  analyzeVideoThumbnail,
  analyzeText,
};
