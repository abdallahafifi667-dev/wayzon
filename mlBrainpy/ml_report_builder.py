"""
ML Report Builder - Report Content Generation
Builds formatted reports for admin communication
"""

from datetime import datetime
from typing import Dict, Any, Optional
from dataclasses import dataclass


@dataclass
class AnomalyInfo:
    """Anomaly information for reports"""
    type: str
    severity: str
    message: str
    recommendation: str = ""
    trace_id: str = ""
    drift_magnitude: float = 0.0


class MLReportBuilder:
    """
    Generates formatted report content for various ML Brain communications
    
    Supports:
    - Weekly summary reports
    - Anomaly alerts
    - System health reports
    - Benchmark results
    """
    
    SEVERITY_EMOJI = {
        "low": "ℹ️",
        "medium": "⚠️",
        "high": "🚨",
        "critical": "🔥"
    }
    
    @classmethod
    def build_weekly_summary(cls, stats: Dict[str, Any]) -> str:
        """
        Build a weekly summary report
        
        Args:
            stats: Dictionary with level, name, accuracy, total_events, etc.
        """
        accuracy_percent = stats.get("accuracy", 0) * 100
        is_mature = stats.get("is_mature", False)
        maturity_status = "Ready for independent decisions ✅" if is_mature else "Still learning 👶"
        
        report = f"""
🧠 *ML Brain Weekly Report*

Maturity Level: {stats.get('level', 0)} ({stats.get('name', 'Unknown')})
Accuracy: {accuracy_percent:.1f}%
Events Processed: {stats.get('total_events', 0):,}

*Data Dynamics:*
- Verified Outcomes: {stats.get('verified_count', 0):,}
- Training Readiness: {'High 🚀' if stats.get('ready_for_training', False) else 'Low 📉'}

*Current Standing:*
Status: {maturity_status}
Generated At: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        """.strip()
        
        return report
    
    @classmethod
    def build_anomaly_alert(cls, anomaly: Dict[str, Any]) -> str:
        """
        Build a targeted anomaly alert
        
        Args:
            anomaly: Dictionary with type, severity, message, recommendation, etc.
        """
        severity = anomaly.get("severity", "low")
        emoji = cls.SEVERITY_EMOJI.get(severity.lower(), "❓")
        
        drift_text = ""
        if anomaly.get("drift_magnitude"):
            drift_text = f"{anomaly['drift_magnitude'] * 100:.2f}%"
        else:
            drift_text = "None"
        
        report = f"""
{emoji} *ML Brain Anomaly Alert*

*Event:* {anomaly.get('type', 'Unknown')}
*Severity:* {severity.upper()}
*Observation:* {anomaly.get('message', 'No details')}

*Recommended Intervention:*
{anomaly.get('recommendation', 'Review and investigate')}

*Technical Context:*
Trace ID: {anomaly.get('trace_id', 'N/A')}
Drift Detected: {drift_text}
        """.strip()
        
        return report
    
    @classmethod
    def build_system_health_report(
        cls,
        ml_stats: Dict[str, Any],
        map_status: Dict[str, Any] = None,
        search_status: Dict[str, Any] = None,
        pending_escalations: int = 0,
        curfew_countries: list = None
    ) -> str:
        """
        Build a comprehensive system health report
        """
        report = "🌍 *System Safety Health Report*\n\n"
        
        # Alert Audit
        report += "🆘 *Alert Audit:*\n"
        report += f"- Pending Escalations: {pending_escalations}\n"
        
        # ML Brain Health
        report += "\n🧠 *ML Brain Health:*\n"
        report += f"- Model Version: {ml_stats.get('version', 'N/A')}\n"
        report += f"- Accuracy Trend: {ml_stats.get('accuracy', 'N/A')}\n"
        report += f"- Total Samples Learned: {ml_stats.get('total_learned', 0):,}\n"
        report += f"- Last Validation Loss: {ml_stats.get('last_loss', 'N/A')}\n"
        
        if curfew_countries:
            report += f"- Curfew Active In: {', '.join(curfew_countries)}\n"
        else:
            report += "- Curfew Active In: None\n"
        
        # Map Providers
        if map_status:
            report += "\n📍 *Map Providers Status:*\n"
            for provider_id, status in map_status.items():
                icon = "✅" if status.get("circuit_state") == "closed" else "⚠️"
                report += f"{icon} *{status.get('name', provider_id)}*: "
                report += f"{status.get('circuit_state', 'unknown')} "
                report += f"({status.get('failures', 0)} failures)\n"
        
        # Search Aggregator
        if search_status:
            report += "\n🔍 *Search Aggregator Status:*\n"
            for engine_id, status in search_status.items():
                icon = "✅" if status.get("enabled") else "❌"
                error_icon = "⚠️" if status.get("failures", 0) > 0 else ""
                report += f"{icon} *{status.get('name', engine_id)}*: "
                report += f"{status.get('success', 0)} ok / {status.get('failures', 0)} fail {error_icon}\n"
        
        return report.strip()
    
    @classmethod
    def build_training_report(cls, stats: Dict[str, Any]) -> str:
        """
        Build a training completion report
        """
        report = f"""
🎓 *ML Brain Training Report*

*Dataset:*
- Total Records: {stats.get('total_records', 0):,}
- Positive Cases: {stats.get('positive_cases', 0):,}
- Negative Cases: {stats.get('negative_cases', 0):,}
- Class Balance: {stats.get('positive_cases', 0) / max(1, stats.get('total_records', 1)) * 100:.1f}% positive

*Performance Metrics:*
- Final Loss: {stats.get('final_loss', 0):.4f}
- Risk Precision: {stats.get('risk_precision', 0):.4f}
- Risk Recall: {stats.get('risk_recall', 0):.4f}
- Risk F1 Score: {stats.get('risk_f1', 0):.4f}

*Training Duration:* {stats.get('training_duration_seconds', 0):.1f}s
*Completed At:* {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        """.strip()
        
        return report
    
    @classmethod
    def build_benchmark_report(
        cls,
        query: str,
        benchmark_results: Dict[str, Any]
    ) -> str:
        """
        Build a search engine benchmark report
        """
        report = f"📊 *Search Engine Cross-Benchmark*\n\n"
        report += f"Query: \"{query}\"\n\n"
        
        for engine, result in benchmark_results.items():
            if result.get("error"):
                report += f"❌ *{engine}*: Failed ({result['error']})\n"
            else:
                report += f"✅ *{engine}*: {result.get('count', 0)} results | "
                report += f"Sentiment: {result.get('sentiment', {}).get('risk_level', 'N/A')}\n"
        
        return report.strip()
    
    @classmethod
    def build_location_audit_report(cls, result: Dict[str, Any]) -> str:
        """
        Build a manual location audit report
        """
        report = f"""
🔍 *Manual Location Audit Report*

📍 *Location*: {result.get('location_name', 'Unknown')}
🗺️ *Address*: {result.get('address', 'N/A')}
⚖️ *Risk Level*: {result.get('risk_level', 'Unknown')} ({result.get('risk_score', 0)}/100)
📝 *Analysis*: {result.get('sentiment', 'No analysis')}
        """.strip()
        
        danger_hits = result.get("danger_hits", [])
        if danger_hits:
            report += "\n\n⚠️ *Warnings Found:*\n"
            for hit in danger_hits:
                report += f"- {hit.get('word', 'Unknown')} ({hit.get('source', 'Unknown')})\n"
        
        return report
    
    @classmethod
    def get_severity_emoji(cls, severity: Optional[str]) -> str:
        """Map severity to representative emoji"""
        if not severity:
            return "❓"
        return cls.SEVERITY_EMOJI.get(severity.lower(), "❓")
