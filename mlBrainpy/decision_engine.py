"""
Decision Engine - Autonomous Safety Decision Making
Production-grade decision logic with personalization and fallback handling
"""

from typing import Dict, Any, Optional
from datetime import datetime
import logging

from config import config
from neural_network import neural_network
from maturity_monitor import maturity_monitor
from data_preprocessor import (
    SafetyEvent, 
    TripDetails, 
    ExtendedData
)
from communication_analyzer import comm_analyzer
from conscious_reasoning_engine import conscious_engine
from internal_logic_engine import internal_logic

logger = logging.getLogger(__name__)


class DecisionEngine:
    """
    Main decision-making engine for the ML Brain
    
    Features:
    - Maturity-gated autonomous decisions
    - Plan-based threshold personalization
    - Emergency override logic
    - Safe fallback handling
    """
    
    def __init__(self):
        self.decision_count = 0
        self.fallback_count = 0
    
    async def get_autonomous_decision(
        self,
        event: SafetyEvent,
        trip_details: TripDetails,
        extended_data: Optional[ExtendedData] = None
    ) -> Dict[str, Any]:
        """
        Main entry point for autonomous decision with enhanced safety
        
        Args:
            event: Current safety event data
            trip_details: Trip context
            extended_data: Extended historical context
            
        Returns:
            Decision dictionary with risk level, actions, and reasoning
        """
        try:
            # 1. Check maturity gate
            is_ready = await maturity_monitor.is_ready()
            if not is_ready:
                logger.debug("ML Brain not mature enough for autonomous decisions")
                return self._get_fallback_decision("not_ready")
            
            # 2. Fetch extended data if not provided
            if extended_data is None:
                extended_data = ExtendedData()
            
            # 3. Extract features and predict
            features = preprocessor.extract_features(event, trip_details, extended_data)
            prediction = neural_network.predict(features)
            
            if prediction is None:
                return self._get_fallback_decision("low_confidence")
            
            # 4. Get model info for audit
            model_info = neural_network.get_info()
            
            # 5. Refine decision with business logic
            decision = self._refine_decision(prediction, event, extended_data)
            
            # 🆕 6. Executive Decision (Internal Brain First)
            # The 'System 1' logic uses rules + NN to decide immediate actions
            executive_decision = internal_logic.decide_action(decision, {**event.__dict__, **trip_details.__dict__})
            decision.update(executive_decision)

            # 7. Local NLP Behavioral Check (Semantic Intelligence)
            if config.NLP_MODEL_ENABLED and getattr(event, 'text_content', None):
                nlp_analysis = comm_analyzer.analyze_message(event.text_content)
                decision["nlp_analysis"] = nlp_analysis
                
                if nlp_analysis["is_ambiguous"]:
                    # Brain recognizes it needs more info (Interactive Intelligence)
                    decision["action"] = "REQUEST_DATA"
                    decision["reasoning"] = f"Broad input detected: {event.text_content}. Need more specific context."
                    decision["data_needed"] = nlp_analysis["missing_entities"]
                
                elif nlp_analysis["is_distressed"]:
                    # Brain independently decides to increase risk based on 'feeling' of the text
                    decision["risk_score"] = max(decision["risk_score"], nlp_analysis["distress_level"])
                    decision["risk_level"] = "warning" if nlp_analysis["distress_level"] < 0.9 else "dangerous"
                    decision["action"] = "URGENT" if decision["risk_level"] == "warning" else "CRITICAL_ADVISORY"
                    decision["should_escalate"] = True

            # 8. Strategic Consultation (Gemini as Fallback)
            if config.CONSCIOUS_MODE_ENABLED:
                # Only consult the 'Strategic Brain' (Gemini) if:
                # 1. Internal logic is low confidence
                # 2. Risk is high/ambiguous
                # 3. Cost-saving threshold is met
                should_consult = (
                    decision.get("needs_consultation", False) or
                    decision.get("risk_score", 0) > config.REASONING_THRESHOLD or
                    decision.get("nlp_analysis", {}).get("is_emergency", False)
                )

                if should_consult:
                    consultation_result = await conscious_engine.reason(
                        {**trip_details.__dict__, "current_action": decision.get("action")},
                        decision
                    )
                    decision["strategic_consultation"] = consultation_result
                    
                    # Strategic override: If Gemini suggests a stronger action, we escalate
                    if consultation_result.get("verdict") in ["ESCALATE", "REVIEW"]:
                        decision["action"] = consultation_result.get("suggested_playbook", decision["action"])
                        decision["review_needed"] = True
                else:
                    decision["strategic_consultation"] = {"verdict": "SKIPPED", "reasoning": "Local brain confident."}

            # 9. Add metadata
            decision["model_version"] = model_info["version"]
            decision["model_trained_at"] = model_info["trained_at"]
            decision["user_personalization"] = {
                "sentiment": extended_data.avg_sentiment,
                "prefers_silent": extended_data.prefers_fewer_messages
            }
            
            self.decision_count += 1
            return decision
            
        except Exception as e:
            logger.error(f"ML Decision Engine error: {e}", exc_info=True)
            self.fallback_count += 1
            return self._get_fallback_decision("error", str(e))
    
    def _refine_decision(
        self,
        prediction: Dict[str, Any],
        event: SafetyEvent,
        user_data: ExtendedData
    ) -> Dict[str, Any]:
        """
        Enhanced decision refinement with personalization and safety checks
        """
        risk_score = prediction["risk_score"]
        use_map_api = prediction["use_map_api"]
        use_ai_api = prediction["use_ai_api"]
        escalate = prediction["escalate"]
        confidence = prediction["confidence"]
        layer_override = prediction["layer_override"]
        
        # Get plan-based thresholds
        plan = user_data.safety_config.get("plan", "free") if user_data.safety_config else "free"
        
        # Handle plan as string or SafetyPlanConfig
        if plan == "free":
            plan_config = config.safety.plans.get("free")
        else:
            plan_config = config.safety.plans.get("premium", config.safety.plans.get("free"))
        
        # Personalization: Users preferring fewer messages get higher thresholds
        prefers_silent = user_data.prefers_fewer_messages or getattr(plan_config, 'disable_auto_questions', False)
        
        ai_threshold = max(0.75, plan_config.ai_threshold) if prefers_silent else plan_config.ai_threshold
        escalation_threshold = max(0.85, plan_config.escalation_threshold) if prefers_silent else plan_config.escalation_threshold
        
        # Double-check confidence
        if confidence < config.safety.confidence_threshold:
            return self._get_fallback_decision("confidence_threshold", str(confidence))
        
        # Validate layer override bounds
        safe_layer_override = max(0, min(9, layer_override))
        
        decision = {
            "risk_score": self._clamp(risk_score, 0, 1),
            "risk_level": self._get_risk_level(risk_score),
            "must_use_maps": use_map_api > 0.5,
            "must_use_ai": use_ai_api > ai_threshold,
            "should_escalate": escalate > escalation_threshold,
            "confidence": self._clamp(confidence, 0, 1),
            "layer_override": safe_layer_override,
            "reasoning": self._generate_reasoning(prediction, prefers_silent, user_data),
            "suggested_layers": self._get_suggested_layers(prediction, prefers_silent),
            "timestamp": datetime.now().isoformat(),
            "decision_source": "ml_brain_v2"
        }
        
        # Emergency override for high risk
        if decision["risk_level"] == "dangerous" and decision["confidence"] > 0.8:
            decision["should_escalate"] = True
            decision["must_use_ai"] = True
            decision["must_use_maps"] = True
            decision["reasoning"] += " - Emergency override activated"
            decision["emergency_override"] = True
        
        return decision
    
    def _get_fallback_decision(
        self,
        reason: str,
        details: str = ""
    ) -> Dict[str, Any]:
        """Generate safe fallback decision"""
        self.fallback_count += 1
        logger.warning(f"ML Brain using fallback decision: {reason} {details}")
        
        return {
            "decision": "fallback",
            "use_legacy": True,
            "reasoning": f"Fallback activated: {reason}{f' - {details}' if details else ''}",
            "risk_level": "unknown",
            "confidence": 0.0,
            "timestamp": datetime.now().isoformat(),
            "decision_source": "legacy_system"
        }
    
    @staticmethod
    def _get_risk_level(score: float) -> str:
        """Convert numeric risk score to categorical level"""
        clamped = max(0, min(1, score))
        if clamped > 0.8:
            return "dangerous"
        if clamped > 0.6:
            return "warning"
        if clamped > 0.4:
            return "caution"
        return "safe"
    
    @staticmethod
    def _get_suggested_layers(
        prediction: Dict[str, Any],
        prefers_silent: bool = False
    ) -> list:
        """Suggest processing layers based on prediction"""
        layers = []
        ai_threshold = 0.75 if prefers_silent else 0.5
        escalation_threshold = 0.85 if prefers_silent else 0.7
        
        if prediction["use_map_api"] > 0.5:
            layers.append(2)
        if prediction["use_ai_api"] > ai_threshold:
            layers.append(3)
        if prediction["escalate"] > escalation_threshold:
            layers.append(4)
        
        return layers
    
    @staticmethod
    def _generate_reasoning(
        prediction: Dict[str, Any],
        prefers_silent: bool,
        user_data: ExtendedData
    ) -> str:
        """Generate human-readable reasoning for the decision"""
        factors = []
        plan = user_data.safety_config.get("plan", "free") if user_data.safety_config else "free"
        
        if prediction["risk_score"] > 0.6:
            factors.append("High risk detected")
        if prediction["use_ai_api"] > (0.75 if prefers_silent else 0.5):
            factors.append("Complex situation needs AI")
        if prediction["escalate"] > (0.85 if prefers_silent else 0.7):
            factors.append("Immediate escalation recommended")
        if prediction["confidence"] < 0.8:
            factors.append(f"Moderate confidence ({prediction['confidence']*100:.0f}%)")
        if prefers_silent:
            factors.append(f"Personalized: Throttling alerts ({plan} plan)")
        
        return ", ".join(factors) or "Normal monitoring flow"
    
    @staticmethod
    def _clamp(value: float, min_val: float, max_val: float) -> float:
        """Clamp value to range"""
        return max(min_val, min(max_val, value))
    
    def get_stats(self) -> Dict[str, Any]:
        """Get decision engine statistics"""
        total = self.decision_count + self.fallback_count
        return {
            "total_decisions": self.decision_count,
            "fallback_count": self.fallback_count,
            "success_rate": self.decision_count / max(1, total)
        }


# Module-level instance
decision_engine = DecisionEngine()
