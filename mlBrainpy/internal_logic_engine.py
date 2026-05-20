import logging
from typing import Dict, Any, List, Optional
from rule_ingestor import ingestor
from neural_network import neural_network

logger = logging.getLogger(__name__)

class InternalLogicEngine:
    """
    The 'System 1' Executive Brain
    Processes raw scores and rules to take immediate platform actions.
    """
    
    def __init__(self):
        self.action_history = []

    def decide_action(self, prediction: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
        """
        Analyzes the correlation between raw scores and situational context.
        Can proactively request missing context if ambiguous.
        """
        # 1. Inputs
        risk_score = prediction.get("risk_score", 0)
        confidence = prediction.get("confidence", 0)
        is_deviation = context.get("is_deviation", False)
        speed = context.get("speed", 0)
        location_type = context.get("location_type", "unknown")
        
        # 2. Proactive Inquiry (Interaction Logic)
        # If the brain 'knows' it lacks specific data to be certain
        if risk_score > 0.3 and location_type == "unknown":
            return {
                "action": "REQUEST_DATA",
                "risk_score": risk_score,
                "reasoning": "Context Ambiguity: High-level location (e.g. 'Cairo') detected but specific area reputation is unknown. Requesting spatial telemetry.",
                "data_needed": ["gps_accuracy", "area_reputation", "nearby_poi"],
                "needs_consultation": False,
                "timestamp": datetime.now().isoformat()
            }

        # 3. Pattern Analysis (Correlation Logic)
        action = "PROCEED"
        reasoning = "Situational parameters are within normal variance."
        needs_consultation = False

        # Pattern: High Risk + Stillness (Potential critical event)
        if risk_score > 0.7 and speed < 5:
            action = "MONITOR_INTENSE"
            reasoning = "Risk-Situational Correlation: High risk detected during low mobility."

        # Pattern: Deviation + Dynamic Changes
        if is_deviation:
            if risk_score > 0.4:
                action = "REROUTE"
                reasoning = "Analyzing deviation: Path anomaly correlates with cautious risk scores."
            else:
                reasoning = "Benign deviation: User is off-path but parameters remain safe."

        # 4. Decision Confidence & Fallback
        if confidence < 0.6 or (is_deviation and risk_score > 0.7):
            needs_consultation = True
            reasoning += " | Complexity threshold reached: Seeking strategic audit."

        return {
            "action": action,
            "risk_score": risk_score,
            "reasoning": reasoning,
            "needs_consultation": needs_consultation,
            "timestamp": datetime.now().isoformat()
        }

# Module instance
internal_logic = InternalLogicEngine()
