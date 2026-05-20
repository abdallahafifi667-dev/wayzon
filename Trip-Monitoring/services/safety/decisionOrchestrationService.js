/**
 * Layer 15: Decision Orchestration Service
 * Action Intelligence: Converts multi-source risk data into structured decisions.
 */

const { logger } = require("../../monitoring/metrics");
const { sendQuestion } = require("../flexibleResponseService");
const { escalateToAdmin } = require("./escalationService");

const PLAYBOOKS = {
  CRITICAL_ADVISORY: {
    action: "emergency_warning",
    intensity: "critical",
    interruptUser: true,
    isAdvisoryOnly: true, // 🆕 Explicit policy
  },
  REROUTE: {
    action: "suggest_alternative",
    intensity: "high",
    interruptUser: true,
    isAdvisoryOnly: true,
  },
  DELAY: {
    action: "recommend_wait",
    intensity: "elevated",
    interruptUser: true,
    isAdvisoryOnly: true,
  },
  MONITOR_INTENSE: {
    action: "stealth_tracking",
    intensity: "medium",
    interruptUser: false,
    isAdvisoryOnly: true,
  },
  PROCEED: {
    action: "normal_tracking",
    intensity: "low",
    interruptUser: false,
    isAdvisoryOnly: true,
  },
};

/**
 * Orchestrate a safety decision based on aggregated risk sources
 * NOTE: This system is ADVISORY ONLY. It does not stop or cancel trips.
 * All warnings are recorded for audit and liability review.
 */
async function orchestrateDecision(input, tripId, tripDetails) {
  const { mlResult, temporalRisk, spatialRisk, aiVerdict } = input;

  // Aggregate risk scores (Weighted)
  const finalRiskScore =
    mlResult.riskScore * 0.4 +
    (aiVerdict?.riskScore || 0) * 0.3 +
    temporalRisk.riskScore * 0.15 +
    spatialRisk.riskScore * 0.15;

  let decision = {
    playbook: "PROCEED",
    reasoning: [],
    confidence: mlResult.confidence || 50,
    actionsTaken: [],
  };

  // 1. Critical Safeguards (Prioritize Legal and High Risk)
  if (temporalRisk.legalStatus === "non_compliant") {
    decision.playbook = "DELAY";
    decision.reasoning.push("Time of trip violates local curfews.");
  }

  if (finalRiskScore > 85 || mlResult.riskLevel === "critical") {
    decision.playbook = "CRITICAL_ADVISORY";
    decision.reasoning.push("Multiple critical risk factors detected.");
  } else if (finalRiskScore > 60 || spatialRisk.riskLevel === "high") {
    decision.playbook = "REROUTE";
    decision.reasoning.push(
      "Current path or destination presents significant risk.",
    );
  } else if (finalRiskScore > 35) {
    decision.playbook = "MONITOR_INTENSE";
    decision.reasoning.push(
      "Elevated risk detected, increasing monitoring frequency.",
    );
  }

  // 2. Execute Playbook Actions
  const playbook = PLAYBOOKS[decision.playbook];

  // Logging/Audit (Crucial for liability)
  if (decision.playbook !== "PROCEED") {
    logger.warn(
      `Safety Decision [${decision.playbook}]: ${decision.reasoning.join(", ")}`,
      {
        tripId,
        riskScore: finalRiskScore,
        mlRisk: mlResult.riskLevel,
      },
    );
    decision.actionsTaken.push("Audit_Logged");
  }

  if (playbook.interruptUser) {
    await executeUserIntervention(tripId, decision.playbook, tripDetails);
    decision.actionsTaken.push(`User_Advisory_Sent: ${decision.playbook}`);
  }

  if (decision.playbook === "CRITICAL_ADVISORY") {
    await escalateToAdmin(tripId, {
      reason: decision.reasoning.join(", "),
      riskScore: finalRiskScore,
      context: { temporalRisk, spatialRisk, mlResult },
    });
    decision.actionsTaken.push("Admin_Notified");
  }

  return {
    ...decision,
    riskScore: finalRiskScore,
    playbookDetails: playbook,
  };
}

/**
 * Send customized advisory/warnings based on playbook
 */
async function executeUserIntervention(tripId, playbookType, tripDetails) {
  const userId = tripDetails.normal; // Using correct 'normal' field for tourist
  if (!userId) return;

  switch (playbookType) {
    case "CRITICAL_ADVISORY":
      await sendQuestion(tripId, userId, "SAFETY_ADVISORY_CRITICAL", {
        template:
          "⚠️ IMPORTANT: Our system detected multiple safety concerns in your current area. We strongly advise exercising caution and staying in well-lit, populated areas.",
      });
      break;
    case "REROUTE":
      await sendQuestion(tripId, userId, "SAFETY_ADVISORY_ADVICE", {
        template:
          "Advisory: We detected safety concerns on this route. If possible, consider following a safer path or heading to a verified safe zone.",
      });
      break;
    case "DELAY":
      await sendQuestion(tripId, userId, "TEMPORAL_ADVISORY", {
        template:
          "Note: Active curfews or nighttime risks detected in this region. We recommend staying in a safe, verified location for the time being.",
      });
      break;
  }
}

module.exports = {
  orchestrateDecision,
  PLAYBOOKS,
};
