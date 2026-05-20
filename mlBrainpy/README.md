# ML Brain Python Service (`mlBrainPy`)

## Overview

The `mlBrainPy` service is a high-performance Python microservice built with FastAPI and PyTorch. It provides advanced safety intelligence and motion trajectory analysis for the Trip Monitoring system, replacing the legacy Node.js-based ML components with a more robust and scalable architecture.

## Key Features

- **Multi-Output Neural Network**: Predicts risk levels and suggests safety actions (Map, AI, Escalation) simultaneously.
- **Ensemble Modeling**: Combines PyTorch Neural Networks with XGBoost for enhanced prediction reliability.
- **Explainability**: Uses SHAP values to provide human-readable reasoning for every safety decision.
- **Autonomous Decision Making**: Maturity-gated logic that empowers the system to act independently as it learns.
- **Silent Vetting**: Advanced trajectory analysis that detects if user deviations are logical (e.g., heading to a POI) before alerting.
- **Automated Training**: Integrated pipeline that fetches raw data from MongoDB and retrains models automatically.

## File Structure

- `api.py`: FastAPI endpoints and Pydantic request/response models.
- `__init__.py`: Orchestration layer (MLBrain class) providing a unified interface.
- `neural_network.py`: PyTorch implementation of the safety prediction network.
- `ensemble_model.py`: Weighted ensemble of Neural Network and XGBoost.
- `decision_engine.py`: Refines raw predictions into actionable safety proposals.
- `explainability.py`: SHAP-based model interpretability.
- `motion_trajectory_brain.py`: Advanced trajectory prediction and POI vetting.
- `trainer.py`: Automated training pipeline with balanced sampling.
- `maturity_monitor.py`: Tracks model progress from 'Infant' to 'Expert'.
- `db_connector.py`: Asynchronous MongoDB access layer.
- `config.py`: System-wide configuration for NN architecture, maturity levels, and safety thresholds.
- `admin_communicator.py`: Dispatch layer for administrator reports and anomaly alerts.
- `ml_report_builder.py`: Formatted report generation (Weekly, Health, Training).
- `alert_policy_engine.py`: Cooldown and threshold management for system alerts.
- `data_preprocessor.py`: Feature engineering and normalization logic.

## API Endpoints

- `GET /health`: Service health check.
- `GET /api/v1/status`: Comprehensive system statistics.
- `POST /api/v1/predict`: Get safety prediction for an event.
- `POST /api/v1/learn`: Submit event for online learning.
- `POST /api/v1/trajectory/analyze`: Analyze motion trajectory and deviation tolerance.
- `POST /api/v1/train/auto`: Trigger automated training from MongoDB.
- `GET /api/v1/maturity`: Current model maturity level and progress.

## Tech Stack

- **Framework**: FastAPI
- **ML Libraries**: PyTorch, XGBoost, Scikit-learn, SHAP
- **Database**: Motor (Async MongoDB)
- **Deployment**: Docker (via `./services/mlBrainPy/Dockerfile`)
