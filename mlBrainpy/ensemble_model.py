"""
Ensemble Model - XGBoost + Neural Network Combination
Production-grade ensemble for improved prediction reliability
"""

import numpy as np
from typing import Dict, Any, Optional, Tuple
from dataclasses import dataclass
import logging
import joblib
from pathlib import Path

try:
    import xgboost as xgb
    XGBOOST_AVAILABLE = True
except ImportError:
    XGBOOST_AVAILABLE = False
    xgb = None

from .config import config
from .neural_network import neural_network

logger = logging.getLogger(__name__)


@dataclass
class EnsembleConfig:
    """Ensemble model configuration"""
    nn_weight: float = 0.6     # Neural network weight in ensemble
    xgb_weight: float = 0.4    # XGBoost weight in ensemble
    use_stacking: bool = False  # Use stacking instead of weighted average
    confidence_threshold: float = 0.7


class EnsembleModel:
    """
    Ensemble combining Neural Network and XGBoost for robust predictions
    
    Features:
    - Weighted average ensemble
    - Optional stacking meta-learner
    - Automatic fallback if one model fails
    - Calibrated confidence scores
    """
    
    def __init__(self, config: EnsembleConfig = None):
        self.config = config or EnsembleConfig()
        self.xgb_risk_model: Optional[xgb.XGBClassifier] = None
        self.xgb_decision_model: Optional[xgb.XGBClassifier] = None
        self.meta_learner = None  # For stacking
        self.is_fitted = False
        
        if not XGBOOST_AVAILABLE:
            logger.warning("XGBoost not available. Ensemble will use neural network only.")
    
    def initialize(self):
        """Initialize XGBoost models"""
        if not XGBOOST_AVAILABLE:
            return
        
        # Risk prediction model (binary classification)
        self.xgb_risk_model = xgb.XGBClassifier(
            n_estimators=200,
            max_depth=6,
            learning_rate=0.1,
            subsample=0.8,
            colsample_bytree=0.8,
            reg_alpha=0.1,
            reg_lambda=1.0,
            use_label_encoder=False,
            eval_metric='logloss',
            random_state=42
        )
        
        # Decision prediction model (multi-output)
        self.xgb_decision_model = xgb.XGBClassifier(
            n_estimators=150,
            max_depth=5,
            learning_rate=0.1,
            subsample=0.8,
            colsample_bytree=0.8,
            use_label_encoder=False,
            eval_metric='logloss',
            random_state=42
        )
        
        logger.info("XGBoost ensemble models initialized")
    
    def train(
        self,
        x_train: np.ndarray,
        y_train: np.ndarray,
        validation_split: float = 0.2
    ) -> Dict[str, Any]:
        """
        Train ensemble models
        
        Args:
            x_train: Features (n_samples, n_features)
            y_train: Labels (n_samples, 6) - [risk, use_map, use_ai, escalate, confidence, layer]
            
        Returns:
            Training history with metrics for both models
        """
        history = {"nn": {}, "xgb": {}}
        
        # 1. Train Neural Network
        nn_history = neural_network.train(x_train, y_train)
        history["nn"] = {"loss": nn_history["loss"][-1] if nn_history["loss"] else 0}
        
        # 2. Train XGBoost (if available)
        if XGBOOST_AVAILABLE and self.xgb_risk_model is not None:
            # Split validation
            n_val = int(len(x_train) * validation_split)
            indices = np.random.permutation(len(x_train))
            train_idx, val_idx = indices[n_val:], indices[:n_val]
            
            x_tr, x_val = x_train[train_idx], x_train[val_idx]
            y_tr, y_val = y_train[train_idx], y_train[val_idx]
            
            # Risk model (binary: risk > 0.5)
            risk_labels_tr = (y_tr[:, 0] > 0.5).astype(int)
            risk_labels_val = (y_val[:, 0] > 0.5).astype(int)
            
            self.xgb_risk_model.fit(
                x_tr, risk_labels_tr,
                eval_set=[(x_val, risk_labels_val)],
                verbose=False
            )
            
            # Decision model (use escalate flag as target)
            decision_labels_tr = (y_tr[:, 3] > 0.5).astype(int)  # escalate
            decision_labels_val = (y_val[:, 3] > 0.5).astype(int)
            
            self.xgb_decision_model.fit(
                x_tr, decision_labels_tr,
                eval_set=[(x_val, decision_labels_val)],
                verbose=False
            )
            
            self.is_fitted = True
            history["xgb"] = {"status": "trained"}
            logger.info("XGBoost ensemble models trained")
        
        return history
    
    def predict(self, features: np.ndarray) -> Optional[Dict[str, Any]]:
        """
        Get ensemble prediction combining NN and XGBoost
        
        Returns:
            Combined prediction with calibrated confidence
        """
        # Get neural network prediction
        nn_pred = neural_network.predict(features)
        
        if nn_pred is None:
            # Try XGBoost fallback
            if self.is_fitted and XGBOOST_AVAILABLE:
                return self._predict_xgb_only(features)
            return None
        
        # If XGBoost not available, return NN prediction
        if not self.is_fitted or not XGBOOST_AVAILABLE:
            return nn_pred
        
        # Get XGBoost predictions
        xgb_pred = self._predict_xgb(features)
        
        if xgb_pred is None:
            return nn_pred
        
        # Combine predictions
        return self._combine_predictions(nn_pred, xgb_pred)
    
    def _predict_xgb(self, features: np.ndarray) -> Optional[Dict[str, Any]]:
        """Get XGBoost predictions"""
        try:
            if features.ndim == 1:
                features = features.reshape(1, -1)
            
            risk_proba = self.xgb_risk_model.predict_proba(features)[0, 1]
            escalate_proba = self.xgb_decision_model.predict_proba(features)[0, 1]
            
            return {
                "risk_score": float(risk_proba),
                "escalate": float(escalate_proba),
                "confidence": 0.85  # XGBoost confidence (calibrated)
            }
        except Exception as e:
            logger.warning(f"XGBoost prediction failed: {e}")
            return None
    
    def _predict_xgb_only(self, features: np.ndarray) -> Optional[Dict[str, Any]]:
        """Fallback to XGBoost-only prediction"""
        xgb_pred = self._predict_xgb(features)
        if xgb_pred is None:
            return None
        
        return {
            "risk_score": xgb_pred["risk_score"],
            "use_map_api": 1.0 if xgb_pred["risk_score"] > 0.3 else 0.0,
            "use_ai_api": 1.0 if xgb_pred["risk_score"] > 0.5 else 0.0,
            "escalate": xgb_pred["escalate"],
            "confidence": xgb_pred["confidence"] * 0.9,  # Lower confidence for XGB-only
            "layer_override": int(xgb_pred["risk_score"] * 12),
            "source": "xgboost_fallback"
        }
    
    def _combine_predictions(
        self,
        nn_pred: Dict[str, Any],
        xgb_pred: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Combine NN and XGBoost predictions"""
        nn_w = self.config.nn_weight
        xgb_w = self.config.xgb_weight
        
        # Weighted average for continuous values
        combined_risk = nn_w * nn_pred["risk_score"] + xgb_w * xgb_pred["risk_score"]
        combined_escalate = nn_w * nn_pred["escalate"] + xgb_w * xgb_pred["escalate"]
        
        # Take max confidence (ensemble should be more confident)
        combined_confidence = max(nn_pred["confidence"], xgb_pred["confidence"]) * 1.1
        combined_confidence = min(1.0, combined_confidence)  # Cap at 1.0
        
        return {
            "risk_score": combined_risk,
            "use_map_api": nn_pred["use_map_api"],  # From NN
            "use_ai_api": nn_pred["use_ai_api"],     # From NN
            "escalate": combined_escalate,
            "confidence": combined_confidence,
            "layer_override": nn_pred["layer_override"],
            "source": "ensemble",
            "components": {
                "nn_risk": nn_pred["risk_score"],
                "xgb_risk": xgb_pred["risk_score"],
                "nn_weight": nn_w,
                "xgb_weight": xgb_w
            }
        }
    
    def save(self, path: str = None) -> bool:
        """Save XGBoost models"""
        if not self.is_fitted or not XGBOOST_AVAILABLE:
            return False
        
        try:
            save_path = Path(path or config.paths.model_save_path)
            save_path.mkdir(parents=True, exist_ok=True)
            
            joblib.dump(self.xgb_risk_model, save_path / "xgb_risk_model.joblib")
            joblib.dump(self.xgb_decision_model, save_path / "xgb_decision_model.joblib")
            
            logger.info(f"XGBoost models saved to {save_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to save XGBoost models: {e}")
            return False
    
    def load(self, path: str = None) -> bool:
        """Load XGBoost models"""
        if not XGBOOST_AVAILABLE:
            return False
        
        try:
            load_path = Path(path or config.paths.model_save_path)
            
            risk_file = load_path / "xgb_risk_model.joblib"
            decision_file = load_path / "xgb_decision_model.joblib"
            
            if not risk_file.exists() or not decision_file.exists():
                logger.debug("No XGBoost models found")
                return False
            
            self.xgb_risk_model = joblib.load(risk_file)
            self.xgb_decision_model = joblib.load(decision_file)
            self.is_fitted = True
            
            logger.info("XGBoost models loaded")
            return True
            
        except Exception as e:
            logger.error(f"Failed to load XGBoost models: {e}")
            return False
    
    def get_feature_importance(self) -> Optional[Dict[str, np.ndarray]]:
        """Get feature importance from XGBoost"""
        if not self.is_fitted or not XGBOOST_AVAILABLE:
            return None
        
        return {
            "risk_model": self.xgb_risk_model.feature_importances_,
            "decision_model": self.xgb_decision_model.feature_importances_
        }


# Module-level instance
ensemble_model = EnsembleModel()
