"""
Neural Network - Multi-Output Safety Prediction Model
Production-grade PyTorch implementation with multi-task learning
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import AdamW
from torch.optim.lr_scheduler import ReduceLROnPlateau
import numpy as np
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple
import logging
import json
import os

from config import config

logger = logging.getLogger(__name__)


class AttentionBlock(nn.Module):
    """Self-attention mechanism for feature importance weighting"""
    
    def __init__(self, embed_dim: int):
        super().__init__()
        self.attention = nn.Sequential(
            nn.Linear(embed_dim, embed_dim // 4),
            nn.Tanh(),
            nn.Linear(embed_dim // 4, 1),
            nn.Softmax(dim=-1)
        )
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weights = self.attention(x)
        return x * weights


class ResidualBlock(nn.Module):
    """Residual connection for better gradient flow"""
    
    def __init__(self, in_features: int, out_features: int, dropout: float = 0.2):
        super().__init__()
        self.fc = nn.Linear(in_features, out_features)
        self.bn = nn.BatchNorm1d(out_features)
        self.dropout = nn.Dropout(dropout)
        self.skip = nn.Linear(in_features, out_features) if in_features != out_features else nn.Identity()
        
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = self.skip(x)
        out = F.relu(self.bn(self.fc(x)))
        out = self.dropout(out)
        return out + residual


class SafetyPredictionNetwork(nn.Module):
    """
    Multi-output neural network for trip safety prediction
    
    Outputs:
        - risk_score: Continuous [0, 1]
        - decisions: [use_map, use_ai, escalate] binary decisions
        - confidence: Model confidence [0, 1]
        - layer_override: Suggested processing layer [0, 12]
    """
    
    def __init__(self, input_dim: int = None, hidden_layers: List[Dict] = None):
        super().__init__()
        
        input_dim = input_dim or config.network.input_features
        hidden_layers = hidden_layers or config.network.hidden_layers
        
        # Feature extraction backbone with batch norm
        layers = []
        in_features = input_dim
        
        for i, layer_config in enumerate(hidden_layers):
            out_features = layer_config["units"]
            
            if config.network.use_batch_norm:
                layers.extend([
                    nn.Linear(in_features, out_features),
                    nn.BatchNorm1d(out_features),
                    nn.ReLU(),
                    nn.Dropout(layer_config["dropout"])
                ])
            else:
                layers.extend([
                    nn.Linear(in_features, out_features),
                    nn.ReLU(),
                    nn.Dropout(layer_config["dropout"])
                ])
            
            in_features = out_features
        
        self.backbone = nn.Sequential(*layers)
        final_features = hidden_layers[-1]["units"]
        
        # Attention for feature weighting
        self.attention = AttentionBlock(final_features)
        
        # Separate output heads (multi-task learning)
        self.risk_head = nn.Sequential(
            nn.Linear(final_features, 8),
            nn.ReLU(),
            nn.Linear(8, 1),
            nn.Sigmoid()
        )
        
        self.decisions_head = nn.Sequential(
            nn.Linear(final_features, 8),
            nn.ReLU(),
            nn.Linear(8, 3),
            nn.Sigmoid()  # [use_map, use_ai, escalate]
        )
        
        self.confidence_head = nn.Sequential(
            nn.Linear(final_features, 4),
            nn.ReLU(),
            nn.Linear(4, 1),
            nn.Sigmoid()
        )
        
        self.layer_head = nn.Sequential(
            nn.Linear(final_features, 4),
            nn.ReLU(),
            nn.Linear(4, 1),
            nn.Sigmoid()  # Will be scaled to 0-12
        )
        
        # Weight initialization
        self._init_weights()
        
    def _init_weights(self):
        """Xavier initialization for better training"""
        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.xavier_uniform_(m.weight)
                if m.bias is not None:
                    nn.init.zeros_(m.bias)
    
    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, ...]:
        """Forward pass returning all prediction heads"""
        features = self.backbone(x)
        features = self.attention(features)
        
        risk = self.risk_head(features)
        decisions = self.decisions_head(features)
        confidence = self.confidence_head(features)
        layer = self.layer_head(features)
        
        return risk, decisions, confidence, layer
    
    def get_feature_importance(self, x: torch.Tensor) -> np.ndarray:
        """Get attention weights for feature importance analysis"""
        with torch.no_grad():
            features = self.backbone(x)
            weights = self.attention.attention(features)
        return weights.cpu().numpy()


class NeuralNetwork:
    """
    High-level wrapper for the safety prediction neural network
    Handles training, inference, serialization, and versioning
    """
    
    def __init__(self):
        self.model: Optional[SafetyPredictionNetwork] = None
        self.optimizer: Optional[AdamW] = None
        self.scheduler: Optional[ReduceLROnPlateau] = None
        self.scaler = None  # For mixed precision training
        
        self.is_trained = False
        self.model_version = config.model.current_version
        self.trained_at: Optional[datetime] = None
        self.dataset_size = 0
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # Loss functions with weights
        self.loss_weights = {
            "risk": 1.0,
            "decisions": 1.0,
            "confidence": 0.5,
            "layer": 0.3
        }
        
        logger.info(f"NeuralNetwork initialized on device: {self.device}")
    
    def initialize(self) -> bool:
        """Initialize model architecture"""
        try:
            self.model = SafetyPredictionNetwork().to(self.device)
            
            self.optimizer = AdamW(
                self.model.parameters(),
                lr=config.network.learning_rate,
                weight_decay=config.network.weight_decay
            )
            
            self.scheduler = ReduceLROnPlateau(
                self.optimizer,
                mode='min',
                factor=config.training.scheduler_factor,
                patience=config.training.scheduler_patience,
                verbose=True
            )
            
            # Mixed precision scaler for GPU
            if config.training.use_mixed_precision and self.device.type == "cuda":
                self.scaler = torch.cuda.amp.GradScaler()
            
            logger.info("Neural network initialized with multi-output architecture")
            return True
            
        except Exception as e:
            logger.error(f"Failed to initialize neural network: {e}")
            return False
    
    def predict(self, features: np.ndarray) -> Optional[Dict[str, Any]]:
        """
        Predict outcomes for given features
        
        Args:
            features: numpy array of shape (input_features,) or (batch, input_features)
            
        Returns:
            Dictionary with predictions or None if confidence too low
        """
        if self.model is None:
            loaded = self.load()
            if not loaded:
                return None
        
        self.model.eval()
        
        with torch.no_grad():
            # Handle single sample vs batch
            if features.ndim == 1:
                features = features.reshape(1, -1)
            
            x = torch.tensor(features, dtype=torch.float32).to(self.device)
            
            risk, decisions, confidence, layer = self.model(x)
            
            # Extract single sample results
            risk_score = float(risk[0, 0].cpu())
            decisions_data = decisions[0].cpu().numpy()
            confidence_val = float(confidence[0, 0].cpu())
            layer_val = float(layer[0, 0].cpu())
            
            result = {
                "risk_score": max(0, min(1, risk_score)),
                "use_map_api": max(0, min(1, decisions_data[0])),
                "use_ai_api": max(0, min(1, decisions_data[1])),
                "escalate": max(0, min(1, decisions_data[2])),
                "confidence": max(0, min(1, confidence_val)),
                "layer_override": int(round(layer_val * 12))  # Scale to 0-12
            }
            
            # Confidence gate
            if result["confidence"] < config.safety.confidence_threshold:
                logger.warning(f"Low confidence prediction: {result['confidence']:.3f}")
                return None
            
            return result
    
    def predict_batch(self, features_batch: np.ndarray) -> List[Optional[Dict[str, Any]]]:
        """Batch prediction for multiple samples"""
        if self.model is None:
            self.load()
        
        self.model.eval()
        results = []
        
        with torch.no_grad():
            x = torch.tensor(features_batch, dtype=torch.float32).to(self.device)
            risk, decisions, confidence, layer = self.model(x)
            
            for i in range(len(features_batch)):
                conf = float(confidence[i, 0].cpu())
                
                if conf < config.safety.confidence_threshold:
                    results.append(None)
                    continue
                
                results.append({
                    "risk_score": float(risk[i, 0].cpu()),
                    "use_map_api": float(decisions[i, 0].cpu()),
                    "use_ai_api": float(decisions[i, 1].cpu()),
                    "escalate": float(decisions[i, 2].cpu()),
                    "confidence": conf,
                    "layer_override": int(round(float(layer[i, 0].cpu()) * 12))
                })
        
        return results
    
    def train(
        self,
        x_train: np.ndarray,
        y_train: np.ndarray,
        use_callbacks: bool = True
    ) -> Dict[str, List[float]]:
        """
        Train the model with a dataset
        
        Args:
            x_train: Features array (n_samples, n_features)
            y_train: Labels array (n_samples, 6) - [risk, use_map, use_ai, escalate, confidence, layer]
            use_callbacks: Whether to use training callbacks
            
        Returns:
            Training history with losses
        """
        if self.model is None:
            self.initialize()
        
        self.model.train()
        
        # Convert to tensors
        x = torch.tensor(x_train, dtype=torch.float32).to(self.device)
        
        # Prepare multi-output labels
        risk_labels = torch.tensor(y_train[:, 0:1], dtype=torch.float32).to(self.device)
        decision_labels = torch.tensor(y_train[:, 1:4], dtype=torch.float32).to(self.device)
        confidence_labels = torch.tensor(y_train[:, 4:5], dtype=torch.float32).to(self.device)
        layer_labels = torch.tensor(y_train[:, 5:6], dtype=torch.float32).to(self.device)
        
        # Create DataLoader
        dataset = torch.utils.data.TensorDataset(
            x, risk_labels, decision_labels, confidence_labels, layer_labels
        )
        dataloader = torch.utils.data.DataLoader(
            dataset,
            batch_size=config.training.batch_size,
            shuffle=True
        )
        
        history = {"loss": [], "risk_loss": [], "decision_loss": []}
        best_loss = float('inf')
        patience_counter = 0
        
        for epoch in range(config.training.epochs):
            epoch_losses = {"total": 0, "risk": 0, "decision": 0}
            
            for batch in dataloader:
                x_batch, risk_batch, decision_batch, conf_batch, layer_batch = batch
                
                self.optimizer.zero_grad()
                
                if self.scaler is not None:
                    # Mixed precision training
                    with torch.cuda.amp.autocast():
                        risk_pred, decision_pred, conf_pred, layer_pred = self.model(x_batch)
                        
                        risk_loss = F.mse_loss(risk_pred, risk_batch)
                        decision_loss = F.binary_cross_entropy(decision_pred, decision_batch)
                        confidence_loss = F.mse_loss(conf_pred, conf_batch)
                        layer_loss = F.mse_loss(layer_pred, layer_batch)
                        
                        total_loss = (
                            self.loss_weights["risk"] * risk_loss +
                            self.loss_weights["decisions"] * decision_loss +
                            self.loss_weights["confidence"] * confidence_loss +
                            self.loss_weights["layer"] * layer_loss
                        )
                    
                    self.scaler.scale(total_loss).backward()
                    self.scaler.unscale_(self.optimizer)
                    torch.nn.utils.clip_grad_norm_(
                        self.model.parameters(),
                        config.training.gradient_clip_value
                    )
                    self.scaler.step(self.optimizer)
                    self.scaler.update()
                else:
                    # Normal training
                    risk_pred, decision_pred, conf_pred, layer_pred = self.model(x_batch)
                    
                    risk_loss = F.mse_loss(risk_pred, risk_batch)
                    decision_loss = F.binary_cross_entropy(decision_pred, decision_batch)
                    confidence_loss = F.mse_loss(conf_pred, conf_batch)
                    layer_loss = F.mse_loss(layer_pred, layer_batch)
                    
                    total_loss = (
                        self.loss_weights["risk"] * risk_loss +
                        self.loss_weights["decisions"] * decision_loss +
                        self.loss_weights["confidence"] * confidence_loss +
                        self.loss_weights["layer"] * layer_loss
                    )
                    
                    total_loss.backward()
                    torch.nn.utils.clip_grad_norm_(
                        self.model.parameters(),
                        config.training.gradient_clip_value
                    )
                    self.optimizer.step()
                
                epoch_losses["total"] += total_loss.item()
                epoch_losses["risk"] += risk_loss.item()
                epoch_losses["decision"] += decision_loss.item()
            
            # Average losses
            n_batches = len(dataloader)
            avg_loss = epoch_losses["total"] / n_batches
            
            history["loss"].append(avg_loss)
            history["risk_loss"].append(epoch_losses["risk"] / n_batches)
            history["decision_loss"].append(epoch_losses["decision"] / n_batches)
            
            # Learning rate scheduling
            self.scheduler.step(avg_loss)
            
            # Early stopping
            if avg_loss < best_loss:
                best_loss = avg_loss
                patience_counter = 0
            else:
                patience_counter += 1
            
            if patience_counter >= config.training.early_stopping_patience:
                logger.info(f"Early stopping at epoch {epoch + 1}")
                break
            
            # Logging
            if use_callbacks and epoch % 10 == 0:
                logger.info(
                    f"Epoch {epoch}: loss={avg_loss:.4f}, "
                    f"risk={epoch_losses['risk']/n_batches:.4f}, "
                    f"decision={epoch_losses['decision']/n_batches:.4f}"
                )
        
        self.is_trained = True
        self.trained_at = datetime.now()
        self.dataset_size = len(x_train)
        
        return history
    
    def save(self, path: str = None) -> bool:
        """Save model with metadata"""
        if self.model is None:
            return False
        
        try:
            save_path = Path(path or config.paths.model_save_path)
            save_path.mkdir(parents=True, exist_ok=True)
            
            # Save model weights
            model_file = save_path / "model.pt"
            torch.save({
                "model_state_dict": self.model.state_dict(),
                "optimizer_state_dict": self.optimizer.state_dict() if self.optimizer else None,
                "scheduler_state_dict": self.scheduler.state_dict() if self.scheduler else None,
            }, model_file)
            
            # Save metadata
            metadata = {
                "version": self.model_version,
                "trained_at": self.trained_at.isoformat() if self.trained_at else None,
                "dataset_size": self.dataset_size,
                "input_features": config.network.input_features,
                "architecture": [l["units"] for l in config.network.hidden_layers]
            }
            
            metadata_file = save_path / "model_metadata.json"
            with open(metadata_file, 'w') as f:
                json.dump(metadata, f, indent=2)
            
            logger.info(f"Model saved to {save_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to save model: {e}")
            return False
    
    def load(self, path: str = None) -> bool:
        """Load model with metadata"""
        try:
            load_path = Path(path or config.paths.model_save_path)
            model_file = load_path / "model.pt"
            
            if not model_file.exists():
                logger.info("No existing model found")
                return False
            
            # Initialize if not already
            if self.model is None:
                self.initialize()
            
            checkpoint = torch.load(model_file, map_location=self.device)
            self.model.load_state_dict(checkpoint["model_state_dict"])
            
            if checkpoint.get("optimizer_state_dict"):
                self.optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
            if checkpoint.get("scheduler_state_dict"):
                self.scheduler.load_state_dict(checkpoint["scheduler_state_dict"])
            
            # Load metadata
            metadata_file = load_path / "model_metadata.json"
            if metadata_file.exists():
                with open(metadata_file) as f:
                    metadata = json.load(f)
                self.model_version = metadata.get("version", self.model_version)
                if metadata.get("trained_at"):
                    self.trained_at = datetime.fromisoformat(metadata["trained_at"])
                self.dataset_size = metadata.get("dataset_size", 0)
            
            self.is_trained = True
            logger.info(f"Model loaded: v{self.model_version}, trained at {self.trained_at}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            return False
    
    def export_onnx(self, path: str = None) -> bool:
        """Export model to ONNX format for production inference"""
        if self.model is None:
            return False
        
        try:
            export_path = Path(path or config.paths.onnx_export_path)
            export_path.mkdir(parents=True, exist_ok=True)
            
            onnx_file = export_path / "model.onnx"
            dummy_input = torch.randn(1, config.network.input_features).to(self.device)
            
            torch.onnx.export(
                self.model,
                dummy_input,
                onnx_file,
                input_names=["features"],
                output_names=["risk", "decisions", "confidence", "layer"],
                dynamic_axes={"features": {0: "batch_size"}},
                opset_version=14
            )
            
            logger.info(f"Model exported to ONNX: {onnx_file}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to export ONNX: {e}")
            return False
    
    def get_info(self) -> Dict[str, Any]:
        """Get model info for monitoring"""
        arch_str = "-".join(
            f"{l['units']}{l['activation'][0]}"
            for l in config.network.hidden_layers
        )
        
        return {
            "version": self.model_version,
            "trained_at": self.trained_at,
            "dataset_size": self.dataset_size,
            "is_trained": self.is_trained,
            "architecture": arch_str,
            "device": str(self.device)
        }


# Module-level instance
neural_network = NeuralNetwork()
