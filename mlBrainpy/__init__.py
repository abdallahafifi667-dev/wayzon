"""
ML Brain - Main Entry Point
Production-grade Machine Learning Safety Prediction System

This module provides the main MLBrain class that orchestrates all components:
- Neural network for safety prediction
- Training pipeline with balanced sampling
- Decision engine with personalization
- Maturity monitoring and gating
- Motion trajectory prediction
- Alert policy management
- Admin communication
"""

import asyncio
from typing import Dict, Any, Optional, List
from datetime import datetime
import logging
import os

from .config import config, MLBrainConfig
from .neural_network import neural_network, NeuralNetwork
from .trainer import trainer, MLTrainer
from .decision_engine import decision_engine, DecisionEngine
from .maturity_monitor import maturity_monitor, MaturityMonitor
from .motion_trajectory_brain import motion_trajectory_brain, MotionTrajectoryBrain
from .alert_policy_engine import alert_policy_engine, AlertPolicyEngine
from .admin_communicator import admin_communicator, AdminCommunicator
from .ml_report_builder import MLReportBuilder
from .data_preprocessor import (
    preprocessor,
    DataPreprocessor,
    SafetyEvent,
    TripDetails,
    ExtendedData
)
from .rule_ingestor import ingestor
from .communication_analyzer import comm_analyzer
from .conscious_reasoning_engine import conscious_engine

logger = logging.getLogger(__name__)

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

__version__ = "2.0.0"
__all__ = [
    "MLBrain",
    "ml_brain",
    "config",
    "SafetyEvent",
    "TripDetails",
    "ExtendedData",
    "neural_network",
    "trainer",
    "decision_engine",
    "maturity_monitor",
    "motion_trajectory_brain",
    "preprocessor",
    "comm_analyzer",
    "conscious_engine",
    "ingestor"
]


class MLBrain:
    """
    Main ML Brain System
    
    Provides a unified interface for:
    - Safety prediction and decision making
    - Model training and learning
    - Maturity tracking
    - Trajectory prediction
    - Admin reporting
    
    Usage:
        ```python
        from mlBrainPy import ml_brain
        
        # Initialize
        await ml_brain.init()
        
        # Get safety decision
        event = SafetyEvent(coordinates=(31.2, 30.0), speed=60)
        trip = TripDetails(_id="trip123", country="EG")
        decision = await ml_brain.get_safety_proposal(event, trip)
        
        # Learn from outcome
        await ml_brain.learn(event, trip)
        ```
    """
    
    def __init__(self):
        self.is_initialized = False
        self.config = config
        self._training_task: Optional[asyncio.Task] = None
        self._last_init_time: Optional[datetime] = None
    
    async def init(self) -> bool:
        """
        Start the ML Brain System
        
        Returns:
            True if initialization succeeded
        """
        if self.is_initialized:
            return True
        
        try:
            # 1. Load or initialize neural network
            await asyncio.get_event_loop().run_in_executor(
                None, neural_network.initialize
            )
            await asyncio.get_event_loop().run_in_executor(
                None, neural_network.load
            )
            
            # 2. Update maturity from stored state
            await maturity_monitor.update_maturity()

            # 3. Initialize Conscious Components
            if self.config.NLP_MODEL_ENABLED:
                await asyncio.get_event_loop().run_in_executor(
                    None, comm_analyzer.initialize
                )
            
            if self.config.CONSCIOUS_MODE_ENABLED:
                await asyncio.get_event_loop().run_in_executor(
                    None, conscious_engine.initialize
                )
                # Initial rule ingestion
                await asyncio.get_event_loop().run_in_executor(
                    None, ingestor.ingest_all
                )
            
            # 4. Schedule background training if in production
            if os.getenv("ML_BRAIN_PRODUCTION"):
                self._schedule_training()
            
            self.is_initialized = True
            self._last_init_time = datetime.now()
            
            logger.info("🧠 Conscious ML Brain System started successfully")
            return True
            
        except Exception as e:
            logger.error(f"Failed to start ML Brain: {e}", exc_info=True)
            return False
    
    async def get_safety_proposal(
        self,
        event: SafetyEvent,
        trip_details: TripDetails,
        extended_data: Optional[ExtendedData] = None
    ) -> Dict[str, Any]:
        """
        Get ML-based safety decision for an event
        
        Args:
            event: Current safety event
            trip_details: Trip context
            extended_data: Optional extended context
            
        Returns:
            Decision dictionary with risk level, actions, and reasoning
        """
        if not self.is_initialized:
            await self.init()
        
        # Get autonomous decision from decision engine
        decision = await decision_engine.get_autonomous_decision(
            event, trip_details, extended_data
        )
        
        if decision and decision.get("confidence", 0) > 0:
            logger.debug(f"ML Brain proposed decision: confidence={decision.get('confidence'):.3f}")
        
        return decision
    
    async def learn(
        self,
        event: SafetyEvent,
        trip_details: TripDetails,
        extended_data: Optional[ExtendedData] = None
    ):
        """
        Learn from an event outcome (online learning)
        """
        if not self.is_initialized:
            await self.init()
        
        await trainer.train_on_new_event(event, trip_details, extended_data)
    
    async def run_full_training(
        self,
        training_records: List[Dict[str, Any]],
        event_map: Dict[str, Dict[str, Any]],
        historical_stats: Dict[str, Any] = None
    ) -> bool:
        """
        Run full training on a dataset
        
        Args:
            training_records: Training data records
            event_map: Mapping of event IDs to event data
            historical_stats: Pre-aggregated statistics
            
        Returns:
            True if training succeeded
        """
        success = await trainer.run_full_training(
            training_records, event_map, historical_stats
        )
        
        if success:
            # Update maturity after training
            await maturity_monitor.update_maturity()
            
            # Send training report
            stats = trainer.get_training_report()
            await admin_communicator.send_training_report(stats)
        
        return success
    
    async def refresh_weights(self):
        """Reload weights from disk"""
        logger.info("Refreshing ML Brain weights from disk...")
        await asyncio.get_event_loop().run_in_executor(
            None, neural_network.load
        )
        await maturity_monitor.update_maturity()
    
    async def analyze_trajectory(
        self,
        trip_id: str,
        coordinates: tuple,
        speed: float,
        bearing: float,
        trip_details: Dict[str, Any],
        map_verifier=None,
        state_manager=None
    ):
        """
        Analyze motion trajectory for deviation tolerance
        """
        return await motion_trajectory_brain.analyze_trajectory(
            trip_id, coordinates, speed, bearing, trip_details,
            map_verifier, state_manager
        )
    
    async def get_maturity_status(self) -> Dict[str, Any]:
        """Get current maturity level and progress"""
        return await maturity_monitor.get_progress_report()
    
    async def is_ready_for_autonomous(self) -> bool:
        """Check if ML Brain is ready for autonomous decisions"""
        return await maturity_monitor.is_ready()
    
    async def send_weekly_report(self):
        """Generate and send weekly maturity report"""
        maturity = await maturity_monitor.get_maturity()
        stats = {
            "level": maturity.level,
            "name": maturity.name,
            "accuracy": maturity.accuracy,
            "total_events": maturity.total_events,
            "is_mature": maturity.is_mature,
            "ready_for_training": True
        }
        await admin_communicator.send_weekly_report(stats)
    
    async def alert_anomaly(self, anomaly: Dict[str, Any]):
        """Send an anomaly alert (respects policy cooldowns)"""
        await admin_communicator.alert_anomaly(anomaly)
    
    def _schedule_training(self):
        """Schedule daily background training"""
        async def training_loop():
            while True:
                # Wait 24 hours
                await asyncio.sleep(24 * 60 * 60)
                
                try:
                    logger.info("Running scheduled daily training...")
                    # In production, fetch training data from database
                    # await self.run_full_training(records, event_map)
                    
                    # Check for weekly report (Sunday)
                    if datetime.now().weekday() == 6:  # Sunday
                        await self.send_weekly_report()
                        
                except Exception as e:
                    logger.error(f"Scheduled training failed: {e}")
        
        self._training_task = asyncio.create_task(training_loop())
        logger.info("Scheduled daily training task started")
    
    def get_model_info(self) -> Dict[str, Any]:
        """Get current model information"""
        return neural_network.get_info()
    
    def get_stats(self) -> Dict[str, Any]:
        """Get comprehensive system statistics"""
        return {
            "version": __version__,
            "is_initialized": self.is_initialized,
            "init_time": self._last_init_time.isoformat() if self._last_init_time else None,
            "model": neural_network.get_info(),
            "decision_engine": decision_engine.get_stats(),
            "training": trainer.get_training_report(),
            "communicator": admin_communicator.get_stats()
        }
    
    async def shutdown(self):
        """Gracefully shutdown the ML Brain"""
        logger.info("Shutting down ML Brain...")
        
        # Cancel scheduled tasks
        if self._training_task:
            self._training_task.cancel()
            try:
                await self._training_task
            except asyncio.CancelledError:
                pass
        
        # Save model state
        neural_network.save()
        
        self.is_initialized = False
        logger.info("ML Brain shutdown complete")


# Global instance
ml_brain = MLBrain()


# Convenience function for quick predictions
async def predict_safety(
    coordinates: tuple,
    speed: float,
    country: str,
    **kwargs
) -> Dict[str, Any]:
    """
    Quick safety prediction helper
    
    Args:
        coordinates: (longitude, latitude)
        speed: Speed in km/h
        country: Country code
        **kwargs: Additional event/trip parameters
        
    Returns:
        Safety decision
    """
    event = SafetyEvent(
        coordinates=coordinates,
        speed=speed,
        **{k: v for k, v in kwargs.items() if hasattr(SafetyEvent, k)}
    )
    
    trip = TripDetails(
        _id=kwargs.get("trip_id", "unknown"),
        country=country,
        **{k: v for k, v in kwargs.items() if hasattr(TripDetails, k)}
    )
    
    await ml_brain.init()
    return await ml_brain.get_safety_proposal(event, trip)
