"""
Admin Communicator - Admin Notifications and Reports
Dispatch layer for sending alerts and reports to administrators
"""

from typing import Dict, Any, Optional, List
from datetime import datetime
from dataclasses import dataclass
import logging
import json

from .ml_report_builder import MLReportBuilder
from .alert_policy_engine import alert_policy_engine

logger = logging.getLogger(__name__)


@dataclass
class DispatchMetadata:
    """Metadata for a dispatched message"""
    category: str
    urgency: bool = False
    timestamp: datetime = None
    extra: Dict[str, Any] = None
    
    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now()
        if self.extra is None:
            self.extra = {}


class AdminCommunicator:
    """
    Responsible for dispatching alerts and reports to administrators
    
    Features:
    - Policy-controlled alert dispatching
    - Multiple report types support
    - Pluggable dispatch backends (logging, webhook, Slack, etc.)
    """
    
    def __init__(self, dispatch_handler=None, audit_logger=None):
        """
        Args:
            dispatch_handler: Optional async callable for custom dispatch
            audit_logger: Optional async callable for audit logging
        """
        self.dispatch_handler = dispatch_handler
        self.audit_logger = audit_logger
        self.dispatch_count = 0
        self.suppressed_count = 0
    
    async def send_weekly_report(self, stats: Dict[str, Any]):
        """
        Dispatch a weekly maturity report
        """
        try:
            message = MLReportBuilder.build_weekly_summary(stats)
            
            logger.info(f"ML Brain Weekly Report dispatched: level={stats.get('level')}")
            
            await self._dispatch(message, DispatchMetadata(
                category="WEEKLY_REPORT",
                extra={"level": stats.get("level"), "accuracy": stats.get("accuracy")}
            ))
            
        except Exception as e:
            logger.error(f"Failed to dispatch weekly report: {e}")
    
    async def alert_anomaly(self, anomaly: Dict[str, Any]):
        """
        Dispatch an anomaly alert if policy allows
        """
        try:
            # 1. Check policy engine
            policy_check = await alert_policy_engine.should_alert(anomaly)
            
            if not policy_check.allowed:
                logger.debug(
                    f"ML Anomaly alert suppressed: type={anomaly.get('type')}, "
                    f"reason={policy_check.reason}"
                )
                self.suppressed_count += 1
                return
            
            # 2. Build content
            message = MLReportBuilder.build_anomaly_alert(anomaly)
            is_urgent = alert_policy_engine.is_urgent(anomaly)
            
            # 3. Dispatch
            logger.warning(
                f"Dispatching ML Anomaly Alert: type={anomaly.get('type')}, "
                f"severity={anomaly.get('severity')}"
            )
            
            await self._dispatch(message, DispatchMetadata(
                category="ANOMALY_ALERT",
                urgency=is_urgent,
                extra={"type": anomaly.get("type"), "severity": anomaly.get("severity")}
            ))
            
            # 4. Mark as dispatched for cooldown
            await alert_policy_engine.mark_as_dispatched(anomaly.get("type", "unknown"))
            
        except Exception as e:
            logger.error(f"Failed to dispatch anomaly alert: {e}")
    
    async def send_system_health_report(
        self,
        ml_stats: Dict[str, Any],
        map_status: Dict[str, Any] = None,
        search_status: Dict[str, Any] = None,
        pending_escalations: int = 0,
        curfew_countries: List[str] = None
    ):
        """
        Dispatch a comprehensive system health report
        """
        try:
            message = MLReportBuilder.build_system_health_report(
                ml_stats=ml_stats,
                map_status=map_status,
                search_status=search_status,
                pending_escalations=pending_escalations,
                curfew_countries=curfew_countries
            )
            
            await self._dispatch(message, DispatchMetadata(category="SYSTEM_HEALTH"))
            
        except Exception as e:
            logger.error(f"Failed to dispatch health report: {e}")
    
    async def send_training_report(self, stats: Dict[str, Any]):
        """
        Dispatch a training completion report
        """
        try:
            message = MLReportBuilder.build_training_report(stats)
            
            await self._dispatch(message, DispatchMetadata(
                category="TRAINING_COMPLETE",
                extra={"f1_score": stats.get("risk_f1"), "records": stats.get("total_records")}
            ))
            
        except Exception as e:
            logger.error(f"Failed to dispatch training report: {e}")
    
    async def trigger_manual_reputation_check(
        self,
        coordinates: tuple,
        country: str,
        reputation_checker=None
    ) -> Optional[Dict[str, Any]]:
        """
        Trigger a manual reputation check for an area
        """
        try:
            if reputation_checker is None:
                logger.warning("No reputation checker provided")
                return None
            
            result = await reputation_checker.check_location_manually(coordinates, country)
            
            message = MLReportBuilder.build_location_audit_report(result)
            
            await self._dispatch(message, DispatchMetadata(
                category="MANUAL_AUDIT",
                extra={"coordinates": coordinates, "country": country}
            ))
            
            return result
            
        except Exception as e:
            logger.error(f"Manual reputation check failed: {e}")
            return None
    
    async def run_search_benchmark(
        self,
        query: str,
        search_aggregator=None
    ) -> Optional[Dict[str, Any]]:
        """
        Run a cross-engine search benchmark
        """
        try:
            if search_aggregator is None:
                logger.warning("No search aggregator provided")
                return None
            
            engines = ["google", "bing", "duckduckgo", "yandex"]
            benchmark_results = {}
            
            for engine in engines:
                try:
                    result = await search_aggregator.aggregate_search(
                        query, 
                        engines=[engine], 
                        limit=3
                    )
                    benchmark_results[engine] = {
                        "count": len(result.get("all_results", [])),
                        "top_title": result.get("all_results", [{}])[0].get("title", "N/A"),
                        "sentiment": search_aggregator.analyze_sentiment(result.get("all_results", []))
                    }
                except Exception as e:
                    benchmark_results[engine] = {"error": str(e)}
            
            message = MLReportBuilder.build_benchmark_report(query, benchmark_results)
            
            await self._dispatch(message, DispatchMetadata(
                category="BENCHMARK",
                extra={"query": query}
            ))
            
            return benchmark_results
            
        except Exception as e:
            logger.error(f"Search benchmark failed: {e}")
            return None
    
    async def _dispatch(self, message: str, metadata: DispatchMetadata):
        """
        Core dispatch logic
        
        Default: Logs to structured logger
        Override with dispatch_handler for custom integrations
        """
        self.dispatch_count += 1
        
        # Structured logging
        logger.info(
            f"[ADMIN_COMMUNICATION] {metadata.category}",
            extra={
                "message_preview": message[:100] + "..." if len(message) > 100 else message,
                "urgency": metadata.urgency,
                "category": metadata.category,
                **metadata.extra
            }
        )
        
        # Audit log
        if self.audit_logger:
            try:
                await self.audit_logger({
                    "action": "ML_BRAIN_URGENT_DISPATCH" if metadata.urgency else "ML_BRAIN_REPORT_DISPATCH",
                    "details": {
                        "message": message,
                        "metadata": {
                            "category": metadata.category,
                            "urgency": metadata.urgency,
                            "timestamp": metadata.timestamp.isoformat(),
                            **metadata.extra
                        }
                    }
                })
            except Exception as e:
                logger.warning(f"Audit logging failed: {e}")
        
        # Custom dispatch handler (Slack, webhook, FCM, etc.)
        if self.dispatch_handler:
            try:
                await self.dispatch_handler(message, metadata)
            except Exception as e:
                logger.error(f"Custom dispatch handler failed: {e}")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get communicator statistics"""
        return {
            "total_dispatched": self.dispatch_count,
            "total_suppressed": self.suppressed_count,
            "suppression_rate": self.suppressed_count / max(1, self.dispatch_count + self.suppressed_count)
        }


# Module-level instance
admin_communicator = AdminCommunicator()
