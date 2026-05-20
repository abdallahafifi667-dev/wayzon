"""
ML Brain System Configuration
Production-grade configuration for safety prediction neural network
"""

from dataclasses import dataclass, field
from typing import Dict, List, Any
from enum import Enum
import os


class MaturityLevel(Enum):
    """Model maturity levels based on training data and accuracy"""
    INFANT = 0      # Just started, observing only
    LEARNING = 1    # Can suggest, not act
    TEEN = 2        # Can assist with supervision
    ADULT = 3       # Independent decisions allowed
    EXPERT = 4      # Can optimize and teach


@dataclass
class MaturityConfig:
    """Maturity level requirements"""
    levels: Dict[int, Dict[str, Any]] = field(default_factory=lambda: {
        0: {"name": "Infant", "min_events": 0, "min_accuracy": 0.0, "capabilities": ["observing"]},
        1: {"name": "Learning", "min_events": 1000, "min_accuracy": 0.60, "capabilities": ["suggesting"]},
        2: {"name": "Teen", "min_events": 30000, "min_accuracy": 0.75, "capabilities": ["assisting"]},
        3: {"name": "Adult", "min_events": 50000, "min_accuracy": 0.85, "capabilities": ["independent_decisions"]},
        4: {"name": "Expert", "min_events": 100000, "min_accuracy": 0.95, "capabilities": ["optimizing", "teaching"]}
    })
    update_interval_hours: int = 24


@dataclass
class NetworkConfig:
    """Neural network architecture configuration"""
    input_features: int = 35  # 🔄 Updated: 27 + 8 user profile features
    hidden_layers: List[Dict[str, Any]] = field(default_factory=lambda: [
        {"units": 128, "activation": "relu", "dropout": 0.4},
        {"units": 64, "activation": "relu", "dropout": 0.3},
        {"units": 32, "activation": "relu", "dropout": 0.2},
        {"units": 16, "activation": "relu", "dropout": 0.1}
    ])
    output_units: int = 6  # [risk, use_map, use_ai, escalate, confidence, layer_override]
    learning_rate: float = 0.001
    weight_decay: float = 0.01  # L2 regularization
    use_batch_norm: bool = True  # Added: Batch normalization for stability


@dataclass
class TrainingConfig:
    """Training pipeline configuration"""
    batch_size: int = 64
    epochs: int = 100
    validation_split: float = 0.2
    online_learning_enabled: bool = True
    data_freshness_days: int = 90
    min_events_for_training: int = 100
    early_stopping_patience: int = 15
    scheduler_factor: float = 0.5
    scheduler_patience: int = 10
    gradient_clip_value: float = 1.0  # Gradient clipping for stability
    use_mixed_precision: bool = True  # FP16 for faster training on GPU


@dataclass
class SafetyPlanConfig:
    """Safety plan thresholds"""
    ai_threshold: float
    escalation_threshold: float
    skip_analysis_interval_ms: int
    disable_auto_questions: bool
    max_geofence_alerts: int


@dataclass
class SafetyConfig:
    """Safety and fallback configuration"""
    confidence_threshold: float = 0.70
    max_consecutive_errors: int = 5
    ab_test_ratio: float = 0.1
    min_confidence_for_autonomous: float = 0.75
    emergency_override_threshold: float = 0.8
    max_risk_score: float = 1.0
    min_risk_score: float = 0.0
    plans: Dict[str, SafetyPlanConfig] = field(default_factory=lambda: {
        "free": SafetyPlanConfig(
            ai_threshold=0.95,
            escalation_threshold=0.99,
            skip_analysis_interval_ms=5 * 60 * 1000,
            disable_auto_questions=True,
            max_geofence_alerts=1
        ),
        "premium": SafetyPlanConfig(
            ai_threshold=0.50,
            escalation_threshold=0.70,
            skip_analysis_interval_ms=0,
            disable_auto_questions=False,
            max_geofence_alerts=float('inf')
        )
    })


@dataclass
class ModelConfig:
    """Model versioning configuration"""
    current_version: str = "2.0.0"
    versioning_enabled: bool = True
    max_versions_to_keep: int = 10
    auto_rollback_on_failure: bool = True


@dataclass
class PathsConfig:
    """File paths configuration"""
    model_save_path: str = "./models/mlBrain"
    checkpoint_path: str = "./models/mlBrain/checkpoints"
    logs_path: str = "./logs/mlBrain"
    onnx_export_path: str = "./models/mlBrain/onnx"


class FeatureIndex:
    """Feature mapping indices for the input tensor"""
    # Core features (0-8)
    LONGITUDE = 0
    LATITUDE = 1
    SPEED = 2
    HOUR = 3
    DAY_OF_WEEK = 4
    BATTERY = 5
    SIGNAL = 6
    DISTANCE_FROM_GUIDE = 7
    TRIP_DURATION = 8
    # History & Patterns (9-11)
    HISTORICAL_RISK = 9
    USER_RESPONSE_RATE = 10
    PREVIOUS_INCIDENTS = 11
    # Context (12-14)
    WEATHER = 12
    COUNTRY_RISK = 13
    TIME_SINCE_LAST_UPDATE = 14
    # Behavioral & Environmental (15-19)
    USER_BEHAVIOR_PATTERN = 15
    TRIP_TYPE = 16
    CROWD_DENSITY = 17
    NEARBY_EVENTS = 18
    ROUTE_COMPLEXITY = 19
    # Guide & Tourist ratings (20-24)
    GUIDE_RATING = 20
    GUIDE_SUCCESS_RATE = 21
    GUIDE_REVIEW_RATING = 22
    TOURIST_RATING = 23
    DESTINATION_POPULARITY = 24
    # User Preferences (25-26)
    USER_SENTIMENT = 25
    PREFERS_FEWER_MESSAGES = 26
    # 🆕 User Profile Features from EmergencyAlert, Chat, Review (27-34)
    USER_TRUST_SCORE = 27         # From aggregated profile
    USER_RISK_SCORE = 28          # From emergency history + incidents
    EMERGENCY_HISTORY_COUNT = 29   # From EmergencyAlert model
    HAS_UNRESOLVED_EMERGENCY = 30  # From EmergencyAlert model
    CHAT_EMERGENCY_RATE = 31       # From Chat model analysis
    REVIEW_AVG_RECEIVED = 32       # From Review model
    EXPERIENCE_TOTAL_TRIPS = 33    # From order history
    EXPERIENCE_INCIDENT_RATE = 34  # From calculated incident rate



# Country risk mapping
COUNTRY_RISK_MAP = {
    # High Risk
    "SY": 0.9, "YE": 0.9, "AF": 0.95, "IQ": 0.8, "SO": 0.9,
    "LY": 0.85, "SD": 0.8, "SS": 0.9, "CF": 0.85, "ML": 0.75,
    # Medium Risk
    "EG": 0.4, "TR": 0.3, "BR": 0.4, "MX": 0.4, "CO": 0.45,
    "VE": 0.5, "ZA": 0.35, "NG": 0.45, "KE": 0.35, "PH": 0.3,
    # Low Risk
    "US": 0.1, "GB": 0.1, "JP": 0.05, "DE": 0.05, "FR": 0.1,
    "CA": 0.08, "AU": 0.08, "NZ": 0.05, "SG": 0.05, "CH": 0.05
}

# Weather risk mapping
WEATHER_RISK_MAP = {
    "clear": 0.0,
    "clouds": 0.2,
    "rain": 0.5,
    "storm": 0.8,
    "snow": 0.9,
    "fog": 0.6,
    "hail": 0.85,
    "tornado": 0.95,
    "hurricane": 1.0
}


@dataclass
class MLBrainConfig:
    """Master configuration class"""
    # ... other configs ...
    maturity: MaturityConfig = field(default_factory=MaturityConfig)
    network: NetworkConfig = field(default_factory=NetworkConfig)
    training: TrainingConfig = field(default_factory=TrainingConfig)
    safety: SafetyConfig = field(default_factory=SafetyConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    features: type = FeatureIndex
    
    # 🆕 Conscious Brain Config
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    CONSCIOUS_MODE_ENABLED: bool = os.getenv("ML_CONSCIOUS_MODE", "true").lower() == "true"
    NLP_MODEL_ENABLED: bool = os.getenv("ML_NLP_ENABLED", "true").lower() == "true"
    REASONING_THRESHOLD: float = float(os.getenv("ML_REASONING_THRESHOLD", "0.4")) # Logic gate
    
    # Environment-based overrides
    def __post_init__(self):
        if os.getenv("ML_BRAIN_DEBUG"):
            self.training.epochs = 10
            self.training.batch_size = 16
        
        if os.getenv("ML_BRAIN_PRODUCTION"):
            self.training.epochs = 200
            self.safety.confidence_threshold = 0.80


# Global configuration instance
config = MLBrainConfig()
