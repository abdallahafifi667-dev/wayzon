"""
ML Trainer - Training Pipeline with Balanced Sampling
Production-grade training with class balancing, evaluation metrics, and online learning
"""

import numpy as np
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime, timedelta
from dataclasses import dataclass
import logging
from collections import Counter

from config import config
from neural_network import neural_network
from data_preprocessor import preprocessor, SafetyEvent, TripDetails, ExtendedData
from db_connector import db_connector

logger = logging.getLogger(__name__)


@dataclass
class TrainingStats:
    """Training statistics and metrics"""
    total_records: int = 0
    positive_cases: int = 0
    negative_cases: int = 0
    final_loss: float = 0.0
    risk_precision: float = 0.0
    risk_recall: float = 0.0
    risk_f1: float = 0.0
    decision_accuracy: Dict[str, float] = None
    training_duration_seconds: float = 0.0
    
    def __post_init__(self):
        if self.decision_accuracy is None:
            self.decision_accuracy = {}


class MLTrainer:
    """
    Production ML Training Pipeline
    
    Features:
    - Balanced sampling for imbalanced datasets
    - Comprehensive evaluation metrics (Precision, Recall, F1)
    - Online learning support
    - Label refinement from outcomes
    """
    
    def __init__(self):
        self.last_training_stats: Optional[TrainingStats] = None
    
    async def run_full_training(
        self,
        training_records: List[Dict[str, Any]],
        event_map: Dict[str, Dict[str, Any]],
        historical_stats: Dict[str, Any] = None
    ) -> bool:
        """
        Background task to train model on recent data
        
        Args:
            training_records: List of training data with features and labels
            event_map: Mapping of event IDs to core event data
            historical_stats: Pre-aggregated historical statistics
            
        Returns:
            True if training succeeded
        """
        start_time = datetime.now()
        
        try:
            if len(training_records) < config.training.min_events_for_training:
                logger.info(f"Insufficient data for ML training: {len(training_records)} records")
                return False
            
            logger.info(f"Starting full ML Brain retraining with {len(training_records)} records...")
            
            # 1. Feature Construction & Enrichment
            x_train = []
            y_train = []
            positive_cases = 0
            
            for record in training_records:
                event_id = record.get("event_id")
                core = event_map.get(event_id) if event_id else None
                
                features = record.get("features", [])
                if len(features) != config.network.input_features:
                    # Pad or skip invalid records
                    if len(features) < config.network.input_features:
                        features.extend([0.0] * (config.network.input_features - len(features)))
                    else:
                        features = features[:config.network.input_features]
                
                # Enrich with historical stats if available
                if historical_stats and core:
                    features = self._enrich_features(features, core, historical_stats)
                
                # Construct labels
                risk = record.get("label", 0.0)
                decisions = self._infer_decisions(risk, record)
                
                labels = [
                    risk,
                    decisions["use_map"],
                    decisions["use_ai"],
                    decisions["escalate"],
                    record.get("confidence", 1.0),
                    record.get("layer", 0) / 12.0  # Normalize to [0, 1]
                ]
                
                x_train.append(features)
                y_train.append(labels)
                
                if risk > 0.5:
                    positive_cases += 1
            
            x_train = np.array(x_train, dtype=np.float32)
            y_train = np.array(y_train, dtype=np.float32)
            
            # 2. Data Balancing (SMOTE-like oversampling for emergencies)
            x_train, y_train = self._balance_dataset(x_train, y_train, positive_cases)
            
            # 3. Train the neural network
            history = neural_network.train(x_train, y_train)
            
            # 4. Evaluate
            evaluation = self._evaluate_model(x_train, y_train)
            
            # 5. Save
            neural_network.save()
            
            # 6. Record stats
            training_duration = (datetime.now() - start_time).total_seconds()
            
            self.last_training_stats = TrainingStats(
                total_records=len(x_train),
                positive_cases=positive_cases,
                negative_cases=len(x_train) - positive_cases,
                final_loss=history["loss"][-1] if history["loss"] else 0.0,
                risk_precision=evaluation["risk"]["precision"],
                risk_recall=evaluation["risk"]["recall"],
                risk_f1=evaluation["risk"]["f1"],
                decision_accuracy=evaluation["decisions"],
                training_duration_seconds=training_duration
            )
            
            logger.info(
                f"ML Brain Training Completed: "
                f"loss={self.last_training_stats.final_loss:.4f}, "
                f"F1={self.last_training_stats.risk_f1:.4f}, "
                f"duration={training_duration:.1f}s"
            )
            
            return True
            
        except Exception as e:
            logger.error(f"ML Training failed: {e}", exc_info=True)
            return False
    
    def _enrich_features(
        self,
        features: List[float],
        core_event: Dict[str, Any],
        stats: Dict[str, Any]
    ) -> List[float]:
        """Patch consolidated features from historical aggregation"""
        from .config import FeatureIndex
        
        features = list(features)  # Make mutable
        
        guide_id = core_event.get("participants", {}).get("guide")
        tourist_id = core_event.get("participants", {}).get("tourist")
        
        guide_stats = stats.get("guides", {}).get(str(guide_id), {})
        tourist_stats = stats.get("tourists", {}).get(str(tourist_id), {})
        
        # Update guide-related features
        if guide_stats:
            features[FeatureIndex.GUIDE_RATING] = guide_stats.get("guide_rating", 5) / 5
            features[FeatureIndex.GUIDE_SUCCESS_RATE] = guide_stats.get("guide_success_rate", 0.9)
            features[FeatureIndex.GUIDE_REVIEW_RATING] = guide_stats.get("review_rating", 5) / 5
        
        # Update tourist-related features
        if tourist_stats:
            features[FeatureIndex.TOURIST_RATING] = tourist_stats.get("rating", 5) / 5
        
        # Destination popularity
        coords = core_event.get("location", {}).get("coordinates", [])
        if coords:
            coord_key = ",".join(map(str, coords))
            features[FeatureIndex.DESTINATION_POPULARITY] = stats.get("destinations", {}).get(
                coord_key, 0.5
            )
        
        return features
    
    def _infer_decisions(self, risk_score: float, record: Dict[str, Any]) -> Dict[str, float]:
        """Heuristic to bootstrap decision labels from raw risk"""
        return {
            "use_map": 1.0 if risk_score > 0.3 else 0.0,
            "use_ai": 1.0,  # Always analyze with AI for training set
            "escalate": 1.0 if risk_score > 0.8 else 0.0
        }
    
    def _balance_dataset(
        self,
        x: np.ndarray,
        y: np.ndarray,
        positive_cases: int
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Balance dataset by oversampling high-risk events
        Uses SMOTE-like technique with noise injection
        """
        if positive_cases == 0 or positive_cases / len(x) >= 0.2:
            return x, y
        
        logger.info("Balancing dataset - Oversampling high risk events...")
        
        x_list = list(x)
        y_list = list(y)
        original_length = len(x_list)
        
        # Find high-risk indices
        high_risk_indices = [i for i, labels in enumerate(y_list) if labels[0] > 0.5]
        
        # Calculate how many samples to add
        target_positive_ratio = 0.3
        target_positive_count = int(len(x_list) * target_positive_ratio / (1 - target_positive_ratio))
        samples_to_add = target_positive_count - positive_cases
        
        if samples_to_add > 0 and high_risk_indices:
            for _ in range(samples_to_add):
                # Random selection from high-risk samples
                idx = np.random.choice(high_risk_indices)
                
                # Add slight noise for variation (SMOTE-like)
                noise = np.random.normal(0, 0.01, x[idx].shape)
                new_x = np.clip(x[idx] + noise, 0, 1)
                
                x_list.append(new_x)
                y_list.append(y[idx].copy())
        
        logger.info(f"Dataset expanded from {original_length} to {len(x_list)} records")
        
        return np.array(x_list), np.array(y_list)
    
    def _evaluate_model(self, x: np.ndarray, y: np.ndarray) -> Dict[str, Any]:
        """
        Calculate Precision/Recall/F1 for risk prediction
        and accuracy for decision outputs
        """
        predictions = neural_network.predict_batch(x)
        
        # Filter out None predictions (low confidence)
        valid_preds = [(p, y_true) for p, y_true in zip(predictions, y) if p is not None]
        
        if not valid_preds:
            return {
                "risk": {"precision": 0, "recall": 0, "f1": 0},
                "decisions": {},
                "samples": len(x)
            }
        
        # Risk evaluation (binary: > 0.5 threshold)
        risk_metrics = self._calculate_binary_metrics(
            [p["risk_score"] for p, _ in valid_preds],
            [y_true[0] for _, y_true in valid_preds],
            threshold=0.5
        )
        
        # Decision evaluations
        decision_names = ["use_map", "use_ai", "escalate"]
        decision_metrics = {}
        
        for i, name in enumerate(decision_names):
            key = f"{name}_api" if name != "escalate" else name
            preds = [p.get(key, p.get(name, 0)) for p, _ in valid_preds]
            labels = [y_true[i + 1] for _, y_true in valid_preds]
            decision_metrics[name] = self._calculate_binary_metrics(preds, labels, threshold=0.5)
        
        return {
            "risk": risk_metrics,
            "decisions": decision_metrics,
            "samples": len(x),
            "valid_predictions": len(valid_preds)
        }
    
    def _calculate_binary_metrics(
        self,
        predictions: List[float],
        labels: List[float],
        threshold: float = 0.5
    ) -> Dict[str, float]:
        """Calculate precision, recall, and F1 score"""
        tp = fp = fn = tn = 0
        
        for pred, label in zip(predictions, labels):
            pred_binary = pred >= threshold
            label_binary = label >= threshold
            
            if pred_binary and label_binary:
                tp += 1
            elif pred_binary and not label_binary:
                fp += 1
            elif not pred_binary and label_binary:
                fn += 1
            else:
                tn += 1
        
        precision = tp / (tp + fp + 1e-7)
        recall = tp / (tp + fn + 1e-7)
        f1 = 2 * (precision * recall) / (precision + recall + 1e-7)
        
        return {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "tn": tn
        }
    
    async def train_on_new_event(
        self,
        event: SafetyEvent,
        trip_details: TripDetails,
        extended_data: Optional[ExtendedData] = None
    ):
        """
        Online learning: Incrementally train on a new event
        Uses smaller learning rate for stability
        """
        if not config.training.online_learning_enabled:
            return
        
        try:
            features = preprocessor.extract_features(event, trip_details, extended_data)
            
            # Default labels for online learning (conservative)
            risk = event.risk_score or 0.0
            decisions = self._infer_decisions(risk, {})
            
            labels = np.array([[
                risk,
                decisions["use_map"],
                decisions["use_ai"],
                decisions["escalate"],
                0.5,  # Neutral confidence until verified
                0.0   # Default layer
            ]], dtype=np.float32)
            
            features = features.reshape(1, -1)
            
            # Single-step gradient update
            neural_network.train(features, labels, use_callbacks=False)
            
            # Probabilistic save (10% chance to avoid I/O overhead)
            if np.random.random() > 0.9:
                neural_network.save()
                
        except Exception as e:
            logger.warning(f"Online learning failed: {e}")
    
    async def refine_labels_with_outcomes(
        self,
        outcomes: List[Dict[str, Any]],
        training_data_updater=None
    ) -> int:
        """
        Refine training labels based on actual outcomes
        
        Args:
            outcomes: List of outcome records with verified emergency status
            training_data_updater: Async function to update training data in DB
            
        Returns:
            Number of records updated
        """
        updated_count = 0
        
        for outcome in outcomes:
            if not outcome.get("final_verdict", {}).get("was_correct_prediction") is not None:
                continue
            
            target_risk = 1.0 if outcome["final_verdict"].get("was_actual_emergency") else 0.0
            confidence = 1.0 if outcome["final_verdict"]["was_actual_emergency"] else 0.8
            
            if training_data_updater:
                await training_data_updater(
                    event_id=outcome.get("event_id"),
                    label=target_risk,
                    confidence=confidence
                )
            
            updated_count += 1
        
        logger.info(f"Refined {updated_count} training records from outcomes")
        return updated_count
    
    async def auto_train_from_database(self, days: int = 90) -> bool:
        """
        Automatically fetch training data from MongoDB and run training
        
        This is the main entry point for scheduled training.
        Fetches rawData from SafetyTrainingData collection and processes it.
        
        Args:
            days: Number of days of data to fetch
            
        Returns:
            True if training succeeded
        """
        try:
            logger.info(f"Starting auto-training from database (last {days} days)...")
            
            # 1. Connect to MongoDB
            if not db_connector.is_connected:
                await db_connector.connect()
            
            # 2. Fetch training data with rawData
            raw_records = await db_connector.get_training_data(days=days)
            
            if len(raw_records) < config.training.min_events_for_training:
                logger.info(f"Insufficient data: {len(raw_records)} records")
                return False
            
            # 3. Fetch historical stats for enrichment
            historical_stats = await db_connector.get_historical_stats()
            
            # 4. Process rawData into features
            training_records = []
            event_map = {}
            
            for record in raw_records:
                raw_data = record.get("rawData", {})
                if not raw_data:
                    continue
                
                # Create SafetyEvent from rawData
                event = SafetyEvent(
                    coordinates=(
                        raw_data.get("coordinates", [0, 0])[0] if isinstance(raw_data.get("coordinates"), list) else 0,
                        raw_data.get("coordinates", [0, 0])[1] if isinstance(raw_data.get("coordinates"), list) else 0
                    ),
                    speed=raw_data.get("speed", 0),
                    timestamp=raw_data.get("timestamp"),
                    device_health=raw_data.get("deviceHealth", {}),
                    distance_from_guide=raw_data.get("distanceFromGuide", 0)
                )
                
                # Create TripDetails from rawData
                trip = TripDetails(
                    _id=raw_data.get("tripId", ""),
                    service_type=raw_data.get("serviceType", "guided"),
                    country=raw_data.get("country")
                )
                
                # Enrich with user stats
                guide_stats = historical_stats.get("guides", {}).get(raw_data.get("guideId", ""), {})
                tourist_stats = historical_stats.get("tourists", {}).get(raw_data.get("touristId", ""), {})
                
                extended = ExtendedData(
                    guide_safety_score=guide_stats.get("guide_rating", 5.0),
                    guide_success_rate=guide_stats.get("guide_success_rate", 0.9),
                    tourist_rating=tourist_stats.get("rating", 5.0) if tourist_stats else 5.0
                )
                
                # Extract features
                features = preprocessor.extract_features(event, trip, extended)
                
                event_id = str(record.get("eventId", ""))
                training_records.append({
                    "event_id": event_id,
                    "features": features.tolist(),
                    "label": record.get("label", 0),
                    "confidence": 1.0
                })
                
                event_map[event_id] = {
                    "location": {"coordinates": raw_data.get("coordinates", [])},
                    "participants": {
                        "guide": raw_data.get("guideId"),
                        "tourist": raw_data.get("touristId")
                    }
                }
            
            logger.info(f"Processed {len(training_records)} records from rawData")
            
            # 5. Run full training
            return await self.run_full_training(training_records, event_map, historical_stats)
            
        except Exception as e:
            logger.error(f"Auto-training from database failed: {e}", exc_info=True)
            return False
    
    def get_training_report(self) -> Dict[str, Any]:
        """Get the latest training statistics"""
        if not self.last_training_stats:
            return {"status": "no_training_yet"}
        
        stats = self.last_training_stats
        return {
            "status": "completed",
            "total_records": stats.total_records,
            "class_balance": {
                "positive": stats.positive_cases,
                "negative": stats.negative_cases,
                "ratio": stats.positive_cases / max(1, stats.total_records)
            },
            "performance": {
                "final_loss": stats.final_loss,
                "risk_precision": stats.risk_precision,
                "risk_recall": stats.risk_recall,
                "risk_f1": stats.risk_f1
            },
            "decision_accuracy": stats.decision_accuracy,
            "duration_seconds": stats.training_duration_seconds
        }


# Module-level instance
trainer = MLTrainer()

