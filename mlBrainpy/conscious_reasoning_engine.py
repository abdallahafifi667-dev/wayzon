import logging
import google.generativeai as genai
from typing import Dict, Any, Optional
from datetime import datetime
import json
import hashlib

from config import config
from rule_ingestor import ingestor

logger = logging.getLogger(__name__)

class ConsciousReasoningEngine:
    """
    Higher Reasoning Layer
    Uses Gemini AI to reason about complex safety events using platform rules.
    """
    
    def __init__(self):
        self.is_initialized = False
        self.model = None
        self.cache = {}  # In-memory TTL cache
        self.cache_ttl = 300  # 5 minutes

    def initialize(self):
        """Setup Gemini API."""
        api_key = getattr(config, "GEMINI_API_KEY", None)
        if not api_key:
            logger.warn("GEMINI_API_KEY not found in config. Reasoning engine disabled.")
            return False
            
        try:
            genai.configure(api_key=api_key)
            self.model = genai.GenerativeModel('gemini-pro')
            self.is_initialized = True
            logger.info("🧠 Conscious Reasoning Engine (Gemini) initialized")
            return True
        except Exception as e:
            logger.error(f"Failed to initialize Gemini: {e}")
            return False

    async def reason(self, context: Dict[str, Any], raw_prediction: Dict[str, Any]) -> Dict[str, Any]:
        """
        Reasons about the current situation using business rules and ML scores.
        """
        if not self.is_initialized:
            return {"status": "disabled", "reasoning": "Reasoning engine not active."}

        # 1. Check Cache
        cache_key = self._generate_cache_key(context, raw_prediction)
        if cache_key in self.cache:
            entry = self.cache[cache_key]
            if (datetime.now() - entry["timestamp"]).total_seconds() < self.cache_ttl:
                logger.debug("Returning cached reasoning")
                return entry["result"]

        # 2. Build Prompt
        knowledge_map = ingestor.get_knowledge_map()
        prompt = self._build_prompt(context, raw_prediction, knowledge_map)

        # 3. Request Gemini
        try:
            response = await self.model.generate_content_async(prompt)
            result = self._parse_response(response.text)
            
            # 4. Cache Result
            self.cache[cache_key] = {
                "timestamp": datetime.now(),
                "result": result
            }
            return result
        except Exception as e:
            logger.error(f"Gemini reasoning failed: {e}")
            return {"status": "error", "reasoning": f"Failed to reason: {str(e)}"}

    def _generate_cache_key(self, context, prediction):
        """Generates a unique key based on similarity of context."""
        # Significant context factors
        key_data = {
            "tripId": context.get("trip_id"),
            "riskLevel": prediction.get("risk_level"),
            "is_emergency": context.get("is_emergency", False),
            "hour": datetime.now().hour
        }
        return hashlib.md5(json.dumps(key_data, sort_keys=True).encode()).hexdigest()

    def _build_prompt(self, context, prediction, rules):
        return f"""
You are the "Strategic Consultant" for the Wayzon Safety Platform.
A local "Executive Brain" has already analyzed the telemetry and proposed an action.
Your task is to perform a "Deep Audit" of this decision using platform business rules.

## PLATFORM BUSINESS RULES:
{rules}

## CURRENT TRIP CONTEXT:
{json.dumps(context, indent=2)}

## EXECUTIVE BRAIN ANALYSIS (Internal Logic):
{json.dumps(prediction, indent=2)}

## YOUR MISSION:
1. Audit the Internal Logic: Does it align with the Business Rules?
2. Validation: Is the proposed "action" appropriate?
3. Strategic Insight: Provide a verdict (ALIGN, ESCALATE, OVERRIDE).
4. Explain your logic in both Arabic and English.

Return JSON only:
{{
  "verdict": "string",
  "confidence": float,
  "reasoning_en": "string",
  "reasoning_ar": "string",
  "suggested_playbook": "string (PROCEED|REROUTE|DELAY|URGENT|CRITICAL_ADVISORY)",
  "strategic_risk": "low|medium|high"
}}
"""

    def _parse_response(self, text):
        try:
            # Clean possible markdown block
            clean_text = re.sub(r'```json|```', '', text).strip()
            return json.loads(clean_text)
        except Exception:
            return {
                "verdict": "REVIEW",
                "reasoning_en": "Failed to parse conscious logic.",
                "reasoning_ar": "فشل نظام الوعي في تحليل البيانات."
            }

# Module instance
conscious_engine = ConsciousReasoningEngine()
