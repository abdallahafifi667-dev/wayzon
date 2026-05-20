import logging
from typing import Dict, Any, List
try:
    from transformers import pipeline
except ImportError:
    pipeline = None

logger = logging.getLogger(__name__)

class CommunicationAnalyzer:
    """
    Local NLP Behavioral Analysis
    Uses semantic sentiment analysis to detect emotional distress.
    """
    
    def __init__(self, model_name: str = "lxyuan/distilbert-base-multilingual-cased-sentiments-student"):
        self.model_name = model_name
        self.classifier = None
        self.is_ready = False

    def initialize(self):
        """Loads the model into memory locally."""
        if pipeline is None:
            logger.warn("Transformers not installed. CommunicationAnalyzer disabled.")
            return False
            
        try:
            logger.info(f"Loading NLP model: {self.model_name}")
            self.classifier = pipeline("sentiment-analysis", model=self.model_name)
            self.is_ready = True
            return True
        except Exception as e:
            logger.error(f"Failed to load NLP model: {e}")
            return False

    def analyze_message(self, text: str) -> Dict[str, Any]:
        """Analyzes a single message for sentiment and informational clarity."""
        if not text:
            return {"sentiment": "neutral", "score": 0.0, "is_distressed": False, "is_ambiguous": False}

        result = {
            "sentiment": "neutral",
            "score": 0.0,
            "is_distressed": False,
            "distress_level": 0.0,
            "is_ambiguous": False,
            "missing_entities": []
        }

        # Logic: Detect Broad/Ambiguous Statements
        # Example: "I am in Cairo" or "Everything is fine" without context
        broad_locations = ["cairo", "alexandria", "egypt", "القاهرة", "الاسكندرية", "مصر"]
        text_lower = text.lower()
        
        if any(loc in text_lower for loc in broad_locations):
            # Check if it lacks specific area details
            if len(text.split()) < 5: # Very short broad statement
                result["is_ambiguous"] = True
                result["missing_entities"].append("specific_location")

        if self.is_ready and self.classifier:
            try:
                prediction = self.classifier(text)[0]
                result["sentiment"] = prediction["label"]
                result["score"] = prediction["score"]
                
                if result["sentiment"].lower() in ["negative", "anger", "fear", "sadness"] and result["score"] > 0.8:
                    result["is_distressed"] = True
                    result["distress_level"] = result["score"]
            except Exception as e:
                logger.error(f"NLP semantic analysis failed: {e}")

        return result

# Module instance
comm_analyzer = CommunicationAnalyzer()
