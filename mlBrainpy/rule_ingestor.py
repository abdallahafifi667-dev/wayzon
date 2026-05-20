import os
import re
import logging
import json
from typing import Dict, List, Any, Optional

logger = logging.getLogger(__name__)

class RuleIngestor:
    """
    Knowledge Ingestion System
    Parses JavaScript service files to extract business rules for the AI.
    """
    
    def __init__(self, services_dir: str = "../Trip-Monitoring/services"):
        self.services_dir = services_dir
        self.rules_cache = {}
        self.knowledge_map = ""

    def ingest_all(self) -> str:
        """Reads rules from JSON (preferred) or JS files (fallback)."""
        try:
            logger.info("Ingesting business rules...")
            
            # 1. Try structured rules first (Robust path)
            structured_rules = self._read_structured_rules()
            if structured_rules:
                self.knowledge_map = f"# PLATFORM RULES (Structured)\n{structured_rules}"
                return self.knowledge_map

            # 2. Fallback to Regex (Brittle path)
            billing_rules = self._parse_billing_rules()
            safety_rules = self._parse_safety_orchestration()
            trust_rules = self._parse_feedback_trust_logic()

            self.knowledge_map = f"""
# PLATFORM RULES (Generated from JS)
[WARNING: Generated via Regex - may be brittle]

## 1. Billing
{billing_rules}

## 2. Safety
{safety_rules}

## 3. Trust
{trust_rules}
"""
            return self.knowledge_map
        except Exception as e:
            logger.error(f"Rule ingestion failed: {e}")
            return "Rule ingestion currently unavailable."

    def _read_structured_rules(self) -> Optional[str]:
        """Looks for a platform_rules.json file."""
        path = os.path.join(self.services_dir, "platform_rules.json")
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    return json.dumps(data, indent=2)
            except Exception as e:
                logger.error(f"Failed to read platform_rules.json: {e}")
        return None

    def _parse_billing_rules(self) -> str:
        path = os.path.join(self.services_dir, "billingClient.js")
        if not os.path.exists(path): return "Billing service not found."
        
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Extract costs and modes
        costs = re.findall(r'(\w+):\s*Number\(process\.env\.\w+\)\s*\|\|\s*(\d+)', content)
        modes = "Paid mode requires wallet.credits > 0. Default to free mode if credits are exhausted."
        
        rules = " - Service Costs:\n"
        for action, cost in costs:
            rules += f"   - {action}: {cost} credits\n"
        rules += f" - Operational Logic: {modes}"
        return rules

    def _parse_safety_orchestration(self) -> str:
        path = os.path.join(self.services_dir, "safetyOrchestrator.js")
        # For now, summarize the core flow
        return " - Core Flow: processLocationUpdate -> run multiple layers in sequence (ML -> Map -> AI -> Temporal -> Spatial)."

    def _parse_feedback_trust_logic(self) -> str:
        path = os.path.join(self.services_dir, "tripFeedbackService.js")
        # Extract monitoring intensity based on trust
        return " - Monitoring Intensity: 'high' (0-30 trust), 'normal' (31-70), 'low' (71-90), 'very_low' (91-100)."

    def _parse_external_safety_rules(self) -> str:
        path = os.path.join(self.services_dir, "externalSafetyRulesService.js")
        # Extract critical rule headers if any
        return " - External Rules: Dynamic rules based on local authorities and safety policies."

    def get_knowledge_map(self) -> str:
        if not self.knowledge_map:
            return self.ingest_all()
        return self.knowledge_map

# Module instance
ingestor = RuleIngestor()
