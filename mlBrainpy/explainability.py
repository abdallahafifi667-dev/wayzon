"""
Explainability Module - SHAP and Feature Importance Analysis
Production-grade model interpretability for safety-critical decisions
"""

import numpy as np
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass
import logging

try:
    import shap
    SHAP_AVAILABLE = True
except ImportError:
    SHAP_AVAILABLE = False
    shap = None

from config import config, FeatureIndex
from neural_network import neural_network

logger = logging.getLogger(__name__)

# Feature names for human-readable explanations
FEATURE_NAMES = [
    "Longitude", "Latitude", "Speed", "Hour", "Day of Week",
    "Battery Level", "Signal Strength", "Distance from Guide", "Trip Duration",
    "Historical Risk", "User Response Rate", "Previous Incidents",
    "Weather Conditions", "Country Risk", "Time Since Update",
    "User Behavior Pattern", "Trip Type", "Crowd Density",
    "Nearby Events", "Route Complexity", "Guide Rating",
    "Guide Success Rate", "Guide Review Rating", "Tourist Rating",
    "Destination Popularity", "User Sentiment", "Prefers Fewer Messages"
]


@dataclass
class FeatureContribution:
    """Individual feature contribution to prediction"""
    feature_name: str
    feature_index: int
    feature_value: float
    contribution: float
    direction: str  # 'positive' or 'negative'


@dataclass
class PredictionExplanation:
    """Complete explanation for a prediction"""
    base_value: float
    predicted_value: float
    top_positive_features: List[FeatureContribution]
    top_negative_features: List[FeatureContribution]
    all_contributions: List[FeatureContribution]
    summary: str


class Explainer:
    """
    Model Explainability using SHAP values
    
    Features:
    - SHAP value computation for neural network predictions
    - Feature importance ranking
    - Human-readable explanations
    - Local and global interpretability
    """
    
    def __init__(self):
        self.background_data: Optional[np.ndarray] = None
        self.shap_explainer = None
        self.is_initialized = False
    
    def initialize(self, background_data: np.ndarray):
        """
        Initialize SHAP explainer with background data
        
        Args:
            background_data: Representative samples for SHAP baseline (100-1000 samples)
        """
        if not SHAP_AVAILABLE:
            logger.warning("SHAP not available. Explainability features disabled.")
            return
        
        try:
            self.background_data = background_data
            
            # Use DeepExplainer for neural networks
            # This requires the model to be in inference mode
            if neural_network.model is not None:
                import torch
                neural_network.model.eval()
                
                # Create a wrapper function for SHAP
                def model_predict(x):
                    with torch.no_grad():
                        x_tensor = torch.tensor(x, dtype=torch.float32).to(neural_network.device)
                        outputs = neural_network.model(x_tensor)
                        # Return risk score as primary output
                        return outputs[0].cpu().numpy()
                
                # Use KernelExplainer for flexibility
                self.shap_explainer = shap.KernelExplainer(
                    model_predict,
                    shap.sample(background_data, min(100, len(background_data)))
                )
                
                self.is_initialized = True
                logger.info(f"SHAP explainer initialized with {len(background_data)} background samples")
                
        except Exception as e:
            logger.error(f"Failed to initialize SHAP explainer: {e}")
    
    def explain_prediction(
        self,
        features: np.ndarray,
        top_k: int = 5
    ) -> Optional[PredictionExplanation]:
        """
        Explain a single prediction using SHAP values
        
        Args:
            features: Input features (n_features,) or (1, n_features)
            top_k: Number of top contributing features to highlight
            
        Returns:
            PredictionExplanation with feature contributions
        """
        if not SHAP_AVAILABLE or not self.is_initialized:
            return self._fallback_explanation(features, top_k)
        
        try:
            if features.ndim == 1:
                features = features.reshape(1, -1)
            
            # Compute SHAP values
            shap_values = self.shap_explainer.shap_values(features)
            
            # Get base value and predicted value
            base_value = self.shap_explainer.expected_value
            if isinstance(base_value, np.ndarray):
                base_value = float(base_value[0])
            
            predicted_value = float(base_value + np.sum(shap_values[0]))
            
            # Build feature contributions
            contributions = []
            for i, (value, shap_val) in enumerate(zip(features[0], shap_values[0])):
                name = FEATURE_NAMES[i] if i < len(FEATURE_NAMES) else f"Feature_{i}"
                contributions.append(FeatureContribution(
                    feature_name=name,
                    feature_index=i,
                    feature_value=float(value),
                    contribution=float(shap_val),
                    direction="positive" if shap_val > 0 else "negative"
                ))
            
            # Sort by absolute contribution
            contributions.sort(key=lambda x: abs(x.contribution), reverse=True)
            
            # Split into positive and negative
            positive = [c for c in contributions if c.contribution > 0][:top_k]
            negative = [c for c in contributions if c.contribution < 0][:top_k]
            
            # Generate summary
            summary = self._generate_summary(positive, negative, predicted_value)
            
            return PredictionExplanation(
                base_value=base_value,
                predicted_value=predicted_value,
                top_positive_features=positive,
                top_negative_features=negative,
                all_contributions=contributions[:10],  # Top 10
                summary=summary
            )
            
        except Exception as e:
            logger.error(f"SHAP explanation failed: {e}")
            return self._fallback_explanation(features, top_k)
    
    def _fallback_explanation(
        self,
        features: np.ndarray,
        top_k: int = 5
    ) -> PredictionExplanation:
        """
        Fallback explanation using feature values and domain knowledge
        """
        if features.ndim == 2:
            features = features[0]
        
        contributions = []
        
        # Risk-related features with domain-weighted importance
        high_importance_features = {
            FeatureIndex.COUNTRY_RISK: 2.0,
            FeatureIndex.HISTORICAL_RISK: 1.5,
            FeatureIndex.SPEED: 1.2,
            FeatureIndex.DISTANCE_FROM_GUIDE: 1.3,
            FeatureIndex.BATTERY: 0.8,
            FeatureIndex.WEATHER: 1.0,
            FeatureIndex.TRIP_TYPE: 1.1,
            FeatureIndex.PREVIOUS_INCIDENTS: 1.4
        }
        
        for i, value in enumerate(features):
            name = FEATURE_NAMES[i] if i < len(FEATURE_NAMES) else f"Feature_{i}"
            importance = high_importance_features.get(i, 0.5)
            
            # Simple heuristic: high values for risk-related features are concerning
            if i in [FeatureIndex.COUNTRY_RISK, FeatureIndex.HISTORICAL_RISK, 
                     FeatureIndex.WEATHER, FeatureIndex.TRIP_TYPE]:
                contribution = value * importance
            elif i in [FeatureIndex.BATTERY, FeatureIndex.SIGNAL,
                       FeatureIndex.GUIDE_RATING, FeatureIndex.GUIDE_SUCCESS_RATE]:
                contribution = -(1 - value) * importance  # Low values are concerning
            else:
                contribution = (value - 0.5) * importance
            
            contributions.append(FeatureContribution(
                feature_name=name,
                feature_index=i,
                feature_value=float(value),
                contribution=contribution,
                direction="positive" if contribution > 0 else "negative"
            ))
        
        contributions.sort(key=lambda x: abs(x.contribution), reverse=True)
        positive = [c for c in contributions if c.contribution > 0][:top_k]
        negative = [c for c in contributions if c.contribution < 0][:top_k]
        
        # Estimate predicted value
        predicted_value = 0.5 + sum(c.contribution for c in contributions) / len(contributions)
        predicted_value = max(0, min(1, predicted_value))
        
        summary = self._generate_summary(positive, negative, predicted_value)
        
        return PredictionExplanation(
            base_value=0.5,
            predicted_value=predicted_value,
            top_positive_features=positive,
            top_negative_features=negative,
            all_contributions=contributions[:10],
            summary=summary + " (fallback analysis)"
        )
    
    def _generate_summary(
        self,
        positive: List[FeatureContribution],
        negative: List[FeatureContribution],
        predicted_value: float
    ) -> str:
        """Generate human-readable summary of the explanation"""
        risk_level = "high" if predicted_value > 0.7 else "moderate" if predicted_value > 0.4 else "low"
        
        summary_parts = [f"Risk assessment: {risk_level} ({predicted_value:.2%})."]
        
        if positive:
            top_risk = positive[0]
            summary_parts.append(
                f"Main risk factor: {top_risk.feature_name} "
                f"(value: {top_risk.feature_value:.2f})."
            )
        
        if negative:
            top_safety = negative[0]
            summary_parts.append(
                f"Main safety factor: {top_safety.feature_name} "
                f"(value: {top_safety.feature_value:.2f})."
            )
        
        return " ".join(summary_parts)
    
    def get_global_feature_importance(
        self,
        sample_data: np.ndarray = None
    ) -> Dict[str, float]:
        """
        Get global feature importance across all predictions
        
        Args:
            sample_data: Optional sample data (uses background data if not provided)
            
        Returns:
            Dictionary mapping feature names to importance scores
        """
        data = sample_data if sample_data is not None else self.background_data
        
        if data is None or not self.is_initialized:
            # Return domain-knowledge based importance
            return self._get_domain_importance()
        
        try:
            # Compute SHAP values for sample
            shap_values = self.shap_explainer.shap_values(data[:min(100, len(data))])
            
            # Average absolute SHAP values per feature
            importance = np.mean(np.abs(shap_values), axis=0)
            
            return {
                FEATURE_NAMES[i] if i < len(FEATURE_NAMES) else f"Feature_{i}": float(imp)
                for i, imp in enumerate(importance)
            }
            
        except Exception as e:
            logger.error(f"Global importance calculation failed: {e}")
            return self._get_domain_importance()
    
    def _get_domain_importance(self) -> Dict[str, float]:
        """Return domain-knowledge based feature importance"""
        return {
            "Country Risk": 0.15,
            "Historical Risk": 0.12,
            "Speed": 0.10,
            "Distance from Guide": 0.10,
            "Trip Type": 0.09,
            "Weather Conditions": 0.08,
            "Previous Incidents": 0.07,
            "Battery Level": 0.06,
            "Guide Rating": 0.05,
            "User Response Rate": 0.05,
            "Crowd Density": 0.04,
            "Signal Strength": 0.03,
            "Route Complexity": 0.03,
            "Destination Popularity": 0.02,
            "User Sentiment": 0.01
        }
    
    def explain_as_dict(
        self,
        features: np.ndarray,
        top_k: int = 5
    ) -> Dict[str, Any]:
        """Get explanation as a serializable dictionary"""
        explanation = self.explain_prediction(features, top_k)
        
        if explanation is None:
            return {"error": "Explanation not available"}
        
        return {
            "base_value": explanation.base_value,
            "predicted_value": explanation.predicted_value,
            "summary": explanation.summary,
            "top_risk_factors": [
                {
                    "feature": c.feature_name,
                    "value": c.feature_value,
                    "contribution": c.contribution
                }
                for c in explanation.top_positive_features
            ],
            "top_safety_factors": [
                {
                    "feature": c.feature_name,
                    "value": c.feature_value,
                    "contribution": abs(c.contribution)
                }
                for c in explanation.top_negative_features
            ]
        }


# Module-level instance
explainer = Explainer()
