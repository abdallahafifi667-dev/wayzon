"""
FastAPI REST Service for ML Brain
Production-grade API for safety prediction and model management
"""

from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime
import logging
import os

# Import ML Brain components
from . import (
    ml_brain,
    SafetyEvent,
    TripDetails,
    ExtendedData,
    neural_network,
    maturity_monitor,
    motion_trajectory_brain,
    trainer,
    admin_communicator
)

logger = logging.getLogger(__name__)

# FastAPI App
app = FastAPI(
    title="ML Brain Safety API",
    description="Production ML-based safety prediction and decision engine",
    version="2.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc"
)

# CORS for Node.js backend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================== Pydantic Models ====================

class CoordinatesModel(BaseModel):
    longitude: float = Field(..., ge=-180, le=180)
    latitude: float = Field(..., ge=-90, le=90)


class DeviceHealthModel(BaseModel):
    battery: float = Field(default=100, ge=0, le=100)
    signal: float = Field(default=4, ge=0, le=4)


class SafetyEventRequest(BaseModel):
    """Request model for safety event"""
    coordinates: CoordinatesModel
    speed: float = Field(default=0, ge=0)
    timestamp: Optional[datetime] = None
    device_health: Optional[DeviceHealthModel] = None
    distance_from_guide: float = Field(default=0, ge=0)
    time_since_last_update: float = Field(default=20, ge=0)
    weather: Optional[str] = "clear"
    risk_score: float = Field(default=0.5, ge=0, le=1)
    crowd_density: float = Field(default=0.5, ge=0, le=1)
    nearby_events_count: int = Field(default=0, ge=0)
    route_complexity: float = Field(default=0.5, ge=0, le=1)


class TripDetailsRequest(BaseModel):
    """Request model for trip details"""
    trip_id: str
    service_type: str = "guided"
    country: Optional[str] = None
    country_name: Optional[str] = None
    actual_start_time: Optional[datetime] = None
    planned_end_time: Optional[datetime] = None
    expected_duration: int = Field(default=0, ge=0)
    user_response_rate: float = Field(default=0.8, ge=0, le=1)
    previous_incidents: int = Field(default=0, ge=0)
    behavior_score: float = Field(default=0.5, ge=0, le=1)
    guide_id: Optional[str] = None
    tourist_id: Optional[str] = None
    destination_country: Optional[str] = None


class ExtendedDataRequest(BaseModel):
    """Request model for extended context"""
    guide_safety_score: float = Field(default=5.0, ge=0, le=5)
    guide_review_rating: float = Field(default=5.0, ge=0, le=5)
    guide_success_rate: float = Field(default=0.9, ge=0, le=1)
    destination_popularity: float = Field(default=0.5, ge=0, le=1)
    tourist_rating: float = Field(default=5.0, ge=0, le=5)
    avg_sentiment: float = Field(default=0.5, ge=0, le=1)
    prefers_fewer_messages: bool = False
    safety_plan: str = "free"


class SafetyPredictionRequest(BaseModel):
    """Combined request for safety prediction"""
    event: SafetyEventRequest
    trip: TripDetailsRequest
    extended_data: Optional[ExtendedDataRequest] = None
    user_profiles: Optional[Dict[str, Any]] = None  # 🆕 Added from userProfileService



class TrajectoryRequest(BaseModel):
    """Request model for trajectory analysis"""
    trip_id: str
    coordinates: CoordinatesModel
    speed: float = Field(..., ge=0)
    bearing: float = Field(..., ge=0, le=360)
    locations: List[Dict[str, Any]] = []


class TrainingDataRequest(BaseModel):
    """Request model for training data"""
    records: List[Dict[str, Any]]
    event_map: Dict[str, Dict[str, Any]]
    historical_stats: Optional[Dict[str, Any]] = None


class AnomalyAlertRequest(BaseModel):
    """Request model for anomaly alert"""
    type: str
    severity: str = "medium"
    message: str
    recommendation: str = ""
    trace_id: Optional[str] = None
    drift_magnitude: float = Field(default=0, ge=0, le=1)
    value: Optional[float] = None


# ==================== Helper Functions ====================

def convert_to_safety_event(request: SafetyEventRequest) -> SafetyEvent:
    """Convert request model to SafetyEvent"""
    return SafetyEvent(
        timestamp=request.timestamp or datetime.now(),
        coordinates=(request.coordinates.longitude, request.coordinates.latitude),
        speed=request.speed,
        device_health={
            "battery": request.device_health.battery if request.device_health else 100,
            "signal": request.device_health.signal if request.device_health else 4
        },
        distance_from_guide=request.distance_from_guide,
        time_since_last_update=request.time_since_last_update,
        weather=request.weather,
        risk_score=request.risk_score,
        crowd_density=request.crowd_density,
        nearby_events_count=request.nearby_events_count,
        route_complexity=request.route_complexity
    )


def convert_to_trip_details(request: TripDetailsRequest) -> TripDetails:
    """Convert request model to TripDetails"""
    return TripDetails(
        _id=request.trip_id,
        service_type=request.service_type,
        country=request.country,
        country_name=request.country_name,
        actual_start_time=request.actual_start_time,
        planned_end_time=request.planned_end_time,
        expected_duration=request.expected_duration,
        user_response_rate=request.user_response_rate,
        previous_incidents=request.previous_incidents,
        behavior_score=request.behavior_score,
        guide=request.guide_id,
        normal=request.tourist_id,
        destination_country=request.destination_country
    )


def convert_to_extended_data(request: Optional[ExtendedDataRequest]) -> Optional[ExtendedData]:
    """Convert request model to ExtendedData"""
    if not request:
        return None
    return ExtendedData(
        guide_safety_score=request.guide_safety_score,
        guide_review_rating=request.guide_review_rating,
        guide_success_rate=request.guide_success_rate,
        destination_popularity=request.destination_popularity,
        tourist_rating=request.tourist_rating,
        avg_sentiment=request.avg_sentiment,
        prefers_fewer_messages=request.prefers_fewer_messages,
        safety_config={"plan": request.safety_plan}
    )


# ==================== Lifecycle Events ====================

@app.on_event("startup")
async def startup_event():
    """Initialize ML Brain on startup"""
    logger.info("Starting ML Brain API...")
    await ml_brain.init()
    logger.info("ML Brain API ready")


@app.on_event("shutdown")
async def shutdown_event():
    """Graceful shutdown"""
    logger.info("Shutting down ML Brain API...")
    await ml_brain.shutdown()


# ==================== API Endpoints ====================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "initialized": ml_brain.is_initialized,
        "version": getattr(ml_brain, "version", None) or os.getenv("ML_BRAIN_VERSION", "2.0.0"),
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/v1/status")
async def get_status():
    """Get comprehensive system status"""
    return ml_brain.get_stats()


@app.get("/api/v1/model/info")
async def get_model_info():
    """Get current model information"""
    return ml_brain.get_model_info()


@app.get("/api/v1/maturity")
async def get_maturity():
    """Get current maturity level and progress"""
    return await ml_brain.get_maturity_status()


@app.get("/api/v1/maturity/ready")
async def check_autonomous_ready():
    """Check if ML Brain is ready for autonomous decisions"""
    is_ready = await ml_brain.is_ready_for_autonomous()
    return {"ready": is_ready}


@app.post("/api/v1/predict")
async def predict_safety(request: SafetyPredictionRequest):
    """
    Get safety prediction for an event
    
    Returns risk assessment, recommended actions, and confidence scores
    """
    try:
        event = convert_to_safety_event(request.event)
        trip = convert_to_trip_details(request.trip)
        extended = convert_to_extended_data(request.extended_data)
        
        # 🆕 Attach user profiles to extended data for preprocessor
        if extended and request.user_profiles:
            extended.user_profiles = request.user_profiles
        elif not extended and request.user_profiles:
            extended = ExtendedData(user_profiles=request.user_profiles)
        
        decision = await ml_brain.get_safety_proposal(event, trip, extended)
        
        return {
            "success": True,
            "decision": decision,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Prediction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/learn")
async def learn_from_event(
    request: SafetyPredictionRequest,
    background_tasks: BackgroundTasks
):
    """
    Submit an event for online learning (runs in background)
    """
    try:
        event = convert_to_safety_event(request.event)
        trip = convert_to_trip_details(request.trip)
        extended = convert_to_extended_data(request.extended_data)
        
        # 🆕 Attach user profiles for learning context
        if extended and request.user_profiles:
            extended.user_profiles = request.user_profiles
        elif not extended and request.user_profiles:
            extended = ExtendedData(user_profiles=request.user_profiles)
            
        background_tasks.add_task(ml_brain.learn, event, trip, extended)
        
        return {
            "success": True,
            "message": "Learning task queued",
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Learning failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/api/v1/trajectory/analyze")
async def analyze_trajectory(request: TrajectoryRequest):
    """
    Analyze motion trajectory for deviation tolerance
    """
    try:
        result = await ml_brain.analyze_trajectory(
            trip_id=request.trip_id,
            coordinates=(request.coordinates.longitude, request.coordinates.latitude),
            speed=request.speed,
            bearing=request.bearing,
            trip_details={"locations": request.locations}
        )
        
        return {
            "success": True,
            "analysis": {
                "status": result.status,
                "prediction": result.prediction,
                "tolerance_score": result.tolerance_score,
                "should_wait": result.should_wait,
                "reasoning": result.reasoning,
                "goal_vetting": {
                    "is_logical": result.goal_vetting.is_logical,
                    "confidence": result.goal_vetting.confidence,
                    "reasons": result.goal_vetting.reasons
                },
                "rejoining": {
                    "rejoins": result.rejoining_analysis.rejoins,
                    "target": result.rejoining_analysis.target,
                    "confidence": result.rejoining_analysis.confidence
                }
            },
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Trajectory analysis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/train")
async def run_training(
    request: TrainingDataRequest,
    background_tasks: BackgroundTasks
):
    """
    Trigger full model training (runs in background)
    """
    try:
        background_tasks.add_task(
            ml_brain.run_full_training,
            request.records,
            request.event_map,
            request.historical_stats
        )
        
        return {
            "success": True,
            "message": "Training task queued",
            "records_count": len(request.records),
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Training trigger failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/train/auto")
async def auto_train(
    background_tasks: BackgroundTasks,
    days: int = 90
):
    """
    Automatically fetch training data from MongoDB and run training
    
    This is the main entry point for scheduled training.
    The ML Brain will:
    1. Connect to MongoDB
    2. Fetch rawData from SafetyTrainingData
    3. Enrich with user/guide stats
    4. Extract features
    5. Run full training
    """
    try:
        background_tasks.add_task(
            trainer.auto_train_from_database,
            days
        )
        
        return {
            "success": True,
            "message": f"Auto-training queued (last {days} days)",
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Auto-training trigger failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/training/report")
async def get_training_report():
    """Get the latest training report"""
    return trainer.get_training_report()


@app.post("/api/v1/model/refresh")
async def refresh_model():
    """Reload model weights from disk"""
    try:
        await ml_brain.refresh_weights()
        return {
            "success": True,
            "message": "Model weights refreshed",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/alert/anomaly")
async def send_anomaly_alert(request: AnomalyAlertRequest):
    """Send an anomaly alert (respects cooldowns)"""
    try:
        await ml_brain.alert_anomaly(request.dict())
        return {
            "success": True,
            "message": "Alert processed",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/report/weekly")
async def send_weekly_report():
    """Generate and send weekly report"""
    try:
        await ml_brain.send_weekly_report()
        return {
            "success": True,
            "message": "Weekly report dispatched",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== Batch Operations ====================

@app.post("/api/v1/predict/batch")
async def predict_batch(requests: List[SafetyPredictionRequest]):
    """
    Batch safety predictions for multiple events
    """
    try:
        results = []
        for req in requests:
            event = convert_to_safety_event(req.event)
            trip = convert_to_trip_details(req.trip)
            extended = convert_to_extended_data(req.extended_data)
            
            decision = await ml_brain.get_safety_proposal(event, trip, extended)
            results.append({
                "trip_id": req.trip.trip_id,
                "decision": decision
            })
        
        return {
            "success": True,
            "results": results,
            "count": len(results),
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Batch prediction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ==================== Run Server ====================

def run_server(host: str = "0.0.0.0", port: int = int(os.getenv("ML_BRAIN_PORT", 8001))):
    """Run the FastAPI server"""
    import uvicorn
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
