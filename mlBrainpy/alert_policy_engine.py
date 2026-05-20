"""
Alert Policy Engine - Cooldown and Threshold Management
Controls when alerts should be dispatched based on policies
"""

from typing import Dict, Any, Optional
from datetime import datetime
from dataclasses import dataclass, field
import logging

logger = logging.getLogger(__name__)


@dataclass
class AlertPolicy:
    """Policy configuration for an alert type"""
    threshold: float  # Minimum value to trigger
    cooldown: int     # Cooldown period in seconds


class InMemoryAlertCache:
    """Simple in-memory cache for alert cooldowns (replace with Redis in production)"""
    
    def __init__(self):
        self._store: Dict[str, float] = {}
    
    async def get(self, key: str) -> Optional[float]:
        return self._store.get(key)
    
    async def set(self, key: str, value: float):
        self._store[key] = value
    
    async def delete(self, key: str):
        self._store.pop(key, None)


@dataclass
class PolicyCheckResult:
    """Result of policy check"""
    allowed: bool
    reason: str = ""


class AlertPolicyEngine:
    """
    Manages alert policies including cooldowns and thresholds
    
    Features:
    - Per-alert-type cooldowns to prevent spam
    - Threshold checks to filter insignificant anomalies
    - Severity-based prioritization
    """
    
    COOLDOWN_PREFIX = "ml:alert:cooldown:"
    
    def __init__(self, cache=None):
        self.cache = cache or InMemoryAlertCache()
        
        # Default policies per anomaly type
        self.policies: Dict[str, AlertPolicy] = {
            "data_drift": AlertPolicy(threshold=0.15, cooldown=3600 * 4),      # 4 hours
            "model_failure": AlertPolicy(threshold=1, cooldown=600),            # 10 minutes
            "accuracy_drop": AlertPolicy(threshold=0.10, cooldown=3600 * 24),   # 24 hours
            "high_risk_trip": AlertPolicy(threshold=0.8, cooldown=300),         # 5 minutes
            "low_confidence": AlertPolicy(threshold=0.5, cooldown=1800),        # 30 minutes
            "emergency": AlertPolicy(threshold=0, cooldown=60),                  # 1 minute (always allow)
        }
    
    async def should_alert(self, anomaly: Dict[str, Any]) -> PolicyCheckResult:
        """
        Determine if an alert should be dispatched based on current policies
        
        Args:
            anomaly: Dict with 'type', 'value', 'severity' keys
            
        Returns:
            PolicyCheckResult indicating if alert is allowed
        """
        anomaly_type = anomaly.get("type", "unknown")
        policy = self.policies.get(anomaly_type, AlertPolicy(threshold=0, cooldown=300))
        
        # 1. Check threshold (if applicable)
        value = anomaly.get("value")
        if value is not None and value < policy.threshold:
            return PolicyCheckResult(
                allowed=False,
                reason=f"Below threshold ({value} < {policy.threshold})"
            )
        
        # 2. Check cooldown
        cooldown_key = self.COOLDOWN_PREFIX + anomaly_type
        last_alert_at = await self.cache.get(cooldown_key)
        now = datetime.now().timestamp()
        
        if last_alert_at is not None:
            elapsed = now - last_alert_at
            if elapsed < policy.cooldown:
                remaining = int(policy.cooldown - elapsed)
                return PolicyCheckResult(
                    allowed=False,
                    reason=f"Cooldown active ({remaining}s remaining)"
                )
        
        return PolicyCheckResult(allowed=True)
    
    async def mark_as_dispatched(self, anomaly_type: str):
        """Mark an alert as dispatched to start the cooldown"""
        cooldown_key = self.COOLDOWN_PREFIX + anomaly_type
        await self.cache.set(cooldown_key, datetime.now().timestamp())
        logger.debug(f"Alert cooldown started for: {anomaly_type}")
    
    async def reset_cooldown(self, anomaly_type: str):
        """Reset cooldown for an alert type (e.g., for testing)"""
        cooldown_key = self.COOLDOWN_PREFIX + anomaly_type
        await self.cache.delete(cooldown_key)
    
    def get_severity_level(self, severity: Optional[str]) -> int:
        """
        Map raw severity to numeric level for easier comparison
        
        Returns:
            1 (low) to 4 (critical)
        """
        levels = {
            "low": 1,
            "medium": 2,
            "high": 3,
            "critical": 4
        }
        return levels.get(severity.lower() if severity else "low", 1)
    
    def is_urgent(self, anomaly: Dict[str, Any]) -> bool:
        """Check if an anomaly is urgent based on severity"""
        severity = anomaly.get("severity", "low")
        return self.get_severity_level(severity) >= 3
    
    def update_policy(
        self,
        anomaly_type: str,
        threshold: Optional[float] = None,
        cooldown: Optional[int] = None
    ):
        """Update policy for a specific anomaly type"""
        current = self.policies.get(anomaly_type, AlertPolicy(threshold=0, cooldown=300))
        
        self.policies[anomaly_type] = AlertPolicy(
            threshold=threshold if threshold is not None else current.threshold,
            cooldown=cooldown if cooldown is not None else current.cooldown
        )
        
        logger.info(f"Updated policy for {anomaly_type}: {self.policies[anomaly_type]}")
    
    def get_all_policies(self) -> Dict[str, Dict[str, Any]]:
        """Get all current policies"""
        return {
            name: {"threshold": p.threshold, "cooldown": p.cooldown}
            for name, p in self.policies.items()
        }


# Module-level instance
alert_policy_engine = AlertPolicyEngine()
