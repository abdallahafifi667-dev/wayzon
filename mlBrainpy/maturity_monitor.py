"""
Maturity Monitor - Model Maturity and Readiness Tracking
Determines when the ML Brain is mature enough for autonomous decisions
"""

from typing import Dict, Any, Optional
from datetime import datetime
from dataclasses import dataclass, asdict
import logging
import json

from .config import config, MaturityLevel

logger = logging.getLogger(__name__)


@dataclass
class MaturityState:
    """Current maturity state of the ML Brain"""
    level: int = 0
    name: str = "Infant"
    total_events: int = 0
    accuracy: float = 0.0
    last_update: float = 0.0
    is_mature: bool = False
    capabilities: list = None
    
    def __post_init__(self):
        if self.capabilities is None:
            self.capabilities = ["observing"]
        if self.last_update == 0.0:
            self.last_update = datetime.now().timestamp()


class InMemoryCache:
    """Simple in-memory cache (replace with Redis in production)"""
    
    def __init__(self):
        self._store: Dict[str, str] = {}
    
    async def get(self, key: str) -> Optional[str]:
        return self._store.get(key)
    
    async def set(self, key: str, value: str):
        self._store[key] = value
    
    async def delete(self, key: str):
        self._store.pop(key, None)


class MaturityMonitor:
    """
    Monitors and tracks the ML Brain's maturity level
    
    Maturity Levels:
    0 - Infant: Just started, observing only
    1 - Learning: Can suggest, not act autonomously  
    2 - Teen: Can assist with human supervision
    3 - Adult: Independent decisions allowed
    4 - Expert: Can optimize and teach other models
    """
    
    MATURITY_KEY = "ml:brain:maturity"
    
    def __init__(self, cache=None):
        self.cache = cache or InMemoryCache()
        self._local_state: Optional[MaturityState] = None
    
    async def get_maturity(self) -> MaturityState:
        """Get current maturity level and stats"""
        try:
            stored = await self.cache.get(self.MATURITY_KEY)
            if stored:
                data = json.loads(stored)
                return MaturityState(**data)
        except Exception as e:
            logger.error(f"Failed to get ML maturity: {e}")
        
        return MaturityState()
    
    async def update_maturity(
        self,
        total_events: int = None,
        accuracy: float = None,
        events_fetcher=None
    ) -> MaturityState:
        """
        Update maturity based on training statistics
        
        Args:
            total_events: Total number of verified outcome events
            accuracy: Model accuracy on verified outcomes
            events_fetcher: Async callable to fetch stats from DB
            
        Returns:
            Updated maturity state
        """
        try:
            current_stats = await self.get_maturity()
            
            # Use provided values or fetch from DB
            if events_fetcher:
                stats = await events_fetcher()
                total_events = stats.get("total_events", 0)
                accuracy = stats.get("accuracy", 0.0)
            elif total_events is None:
                total_events = current_stats.total_events
                accuracy = accuracy or current_stats.accuracy
            
            # Determine new level based on thresholds
            new_level = 0
            level_config = None
            
            for level, requirements in config.maturity.levels.items():
                if (total_events >= requirements["min_events"] and 
                    accuracy >= requirements["min_accuracy"]):
                    new_level = level
                    level_config = requirements
            
            if level_config is None:
                level_config = config.maturity.levels[0]
            
            matured = MaturityState(
                level=new_level,
                name=level_config["name"],
                total_events=total_events,
                accuracy=accuracy,
                last_update=datetime.now().timestamp(),
                is_mature=new_level >= 3,  # Adult level is mature
                capabilities=level_config["capabilities"]
            )
            
            # Store updated state
            await self.cache.set(self.MATURITY_KEY, json.dumps(asdict(matured)))
            self._local_state = matured
            
            # Log level up
            if new_level > current_stats.level:
                logger.info(
                    f"🎉 ML Brain matured to level {new_level}: {matured.name}! "
                    f"(Events: {total_events}, Accuracy: {accuracy:.2%})"
                )
            
            return matured
            
        except Exception as e:
            logger.error(f"Failed to update ML maturity: {e}")
            return await self.get_maturity()
    
    async def is_ready(self) -> bool:
        """
        Check if ML is ready to make autonomous decisions
        
        Requirements:
        - Maturity level >= 3 (Adult)
        - ML_BRAIN_ENABLED environment flag is true
        """
        maturity = await self.get_maturity()
        
        # In production, also check environment flag
        import os
        ml_enabled = os.getenv("ML_BRAIN_ENABLED", "false").lower() == "true"
        
        return maturity.is_mature and ml_enabled
    
    async def get_capabilities(self) -> list:
        """Get current capabilities based on maturity level"""
        maturity = await self.get_maturity()
        return maturity.capabilities
    
    async def can_perform(self, capability: str) -> bool:
        """Check if the current maturity level supports a capability"""
        capabilities = await self.get_capabilities()
        return capability in capabilities
    
    def get_level_requirements(self, target_level: int) -> Dict[str, Any]:
        """Get requirements to reach a target maturity level"""
        requirements = config.maturity.levels.get(target_level)
        if not requirements:
            return {"error": f"Unknown level: {target_level}"}
        
        return {
            "level": target_level,
            "name": requirements["name"],
            "min_events": requirements["min_events"],
            "min_accuracy": requirements["min_accuracy"],
            "unlocked_capabilities": requirements["capabilities"]
        }
    
    async def get_progress_report(self) -> Dict[str, Any]:
        """Get detailed progress report towards next maturity level"""
        current = await self.get_maturity()
        next_level = current.level + 1
        
        if next_level > 4:
            return {
                "current": asdict(current),
                "next_level": None,
                "message": "Maximum maturity level reached!"
            }
        
        next_requirements = config.maturity.levels[next_level]
        
        events_needed = max(0, next_requirements["min_events"] - current.total_events)
        accuracy_gap = max(0, next_requirements["min_accuracy"] - current.accuracy)
        
        return {
            "current": {
                "level": current.level,
                "name": current.name,
                "total_events": current.total_events,
                "accuracy": current.accuracy,
                "is_mature": current.is_mature
            },
            "next_level": {
                "level": next_level,
                "name": next_requirements["name"],
                "events_needed": events_needed,
                "accuracy_gap": accuracy_gap,
                "will_unlock": next_requirements["capabilities"]
            },
            "progress": {
                "events_progress": min(1.0, current.total_events / next_requirements["min_events"]),
                "accuracy_progress": min(1.0, current.accuracy / next_requirements["min_accuracy"])
            }
        }


# Module-level instance
maturity_monitor = MaturityMonitor()
