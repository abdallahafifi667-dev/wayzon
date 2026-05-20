"""
Data Preprocessor - Feature Engineering and Normalization
Production-grade feature extraction for safety prediction
"""

import numpy as np
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass
import logging
import math

from config import (
    config, 
    FeatureIndex, 
    COUNTRY_RISK_MAP, 
    WEATHER_RISK_MAP
)

logger = logging.getLogger(__name__)


@dataclass
class ExtendedData:
    """Extended context data from external sources"""
    guide_safety_score: float = 5.0
    guide_review_rating: float = 5.0
    guide_success_rate: float = 0.9
    destination_popularity: float = 0.5
    tourist_rating: float = 5.0
    avg_sentiment: float = 0.5
    prefers_fewer_messages: bool = False
    safety_config: Dict[str, Any] = None
    user_profiles: Optional[Dict[str, Any]] = None  # 🆕 Aggregated user behavior data
    
    def __post_init__(self):
        if self.safety_config is None:
            self.safety_config = {"plan": "free"}
        if self.user_profiles is None:
            self.user_profiles = {}



@dataclass
class TripDetails:
    """Trip context information"""
    _id: str
    service_type: str = "guided"
    country: str = None
    country_name: str = None
    actual_start_time: datetime = None
    planned_end_time: datetime = None
    expected_duration: int = 0  # minutes
    user_response_rate: float = 0.8
    previous_incidents: int = 0
    behavior_score: float = 0.5
    guide: str = None
    normal: str = None  # tourist ID
    destination_country: str = None
    locations: List[Dict] = None
    
    def __post_init__(self):
        if self.locations is None:
            self.locations = []


@dataclass
class SafetyEvent:
    """Safety event data"""
    timestamp: datetime = None
    coordinates: Tuple[float, float] = (0.0, 0.0)
    speed: float = 0.0
    device_health: Dict[str, float] = None
    distance_from_guide: float = 0.0
    time_since_last_update: float = 20.0
    weather: str = "clear"
    risk_score: float = 0.5
    crowd_density: float = 0.5
    nearby_events_count: int = 0
    route_complexity: float = 0.5
    
    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now()
        if self.device_health is None:
            self.device_health = {"battery": 100, "signal": 4}


@dataclass
class UserProfile:
    """
    🆕 User profile data aggregated from EmergencyAlert, Chat, Review, TripFeedback
    This data helps ML understand user behavior patterns before the trip
    """
    trust_score: float = 50.0           # 0-100 from aggregated profile
    risk_score: float = 30.0            # 0-100 from emergency history + incidents
    risk_level: str = "medium"          # low, medium, high
    
    # From EmergencyAlert model
    emergency_total_incidents: int = 0
    has_unresolved_emergency: bool = False
    
    # From Chat model analysis
    uses_emergency_keywords: bool = False
    emergency_keyword_rate: float = 0.0
    
    # From Review model
    avg_rating_received: float = 4.0
    review_sentiment: str = "neutral"   # positive, neutral, negative
    
    # From trip history
    total_trips: int = 0
    incident_rate: float = 0.0
    completion_rate: float = 1.0
    
    # ML-ready normalized features
    ml_features: Dict[str, float] = None
    
    def __post_init__(self):
        if self.ml_features is None:
            self.ml_features = {
                "trustNormalized": self.trust_score / 100,
                "riskNormalized": self.risk_score / 100,
                "experienceNormalized": min(1.0, self.total_trips / 50),
                "ratingNormalized": self.avg_rating_received / 5,
            }



class DataPreprocessor:
    """
    Feature engineering and normalization utilities for ML Brain
    Implements vectorized operations for performance
    """
    
    def __init__(self):
        self.feature_count = config.network.input_features
        
    @staticmethod
    def normalize(value: float, min_val: float, max_val: float) -> float:
        """Normalize value to [0, 1] range"""
        if value < min_val:
            return 0.0
        if value > max_val:
            return 1.0
        return (value - min_val) / (max_val - min_val)
    
    @staticmethod
    def map_weather(weather: Optional[str]) -> float:
        """Map weather condition to risk score"""
        if not weather:
            return 0.1
        return WEATHER_RISK_MAP.get(weather.lower(), 0.1)
    
    @staticmethod
    def map_country_risk(country: Optional[str]) -> float:
        """Map country code to risk score"""
        if not country:
            return 0.5
        return COUNTRY_RISK_MAP.get(country.upper(), 0.3)
    
    @staticmethod
    def calculate_trip_type(
        now: datetime, 
        trip_details: TripDetails,
        is_in_curfew: bool = False
    ) -> float:
        """
        Calculate trip type risk factor based on time and duration
        Returns: 0.0-1.0 (higher = more risky trip type)
        """
        hour = now.hour
        is_night = hour >= 22 or hour < 6
        is_long = trip_details.expected_duration > 240  # 4h+
        
        if is_in_curfew:
            return 1.0
        if is_night and is_long:
            return 0.9
        if is_night:
            return 0.7
        if is_long:
            return 0.4
        return 0.1
    
    def extract_features(
        self,
        event: SafetyEvent,
        trip_details: TripDetails,
        extended_data: Optional[ExtendedData] = None
    ) -> np.ndarray:
        """
        Extract features from trip events and context
        Returns: numpy array of shape (input_features,)
        """
        if extended_data is None:
            extended_data = ExtendedData()
            
        features = np.zeros(self.feature_count, dtype=np.float32)
        now = event.timestamp or datetime.now()
        
        # 0, 1: Coordinates (normalized to [-1, 1] range then shifted to [0, 1])
        lng, lat = event.coordinates
        features[FeatureIndex.LONGITUDE] = self.normalize(lng, -180, 180)
        features[FeatureIndex.LATITUDE] = self.normalize(lat, -90, 90)
        
        # 2: Speed (km/h, max 200)
        features[FeatureIndex.SPEED] = self.normalize(event.speed, 0, 200)
        
        # 3, 4: Temporal features (cyclical encoding would be better for production)
        features[FeatureIndex.HOUR] = self.normalize(now.hour, 0, 23)
        features[FeatureIndex.DAY_OF_WEEK] = self.normalize(now.weekday(), 0, 6)
        
        # 5, 6: Device Health
        battery = event.device_health.get("battery", 100)
        signal = event.device_health.get("signal", 4)
        features[FeatureIndex.BATTERY] = battery / 100.0
        features[FeatureIndex.SIGNAL] = signal / 4.0
        
        # 7, 8: Distance & Duration (solo trips have 0 distance from guide)
        is_solo = trip_details.service_type == "solo_system"
        distance = 0 if is_solo else event.distance_from_guide
        features[FeatureIndex.DISTANCE_FROM_GUIDE] = self.normalize(distance, 0, 50000)
        
        if trip_details.actual_start_time:
            elapsed = (now - trip_details.actual_start_time).total_seconds() / 60
            features[FeatureIndex.TRIP_DURATION] = self.normalize(elapsed, 0, 1440)
        
        # 9-11: History & Patterns
        features[FeatureIndex.HISTORICAL_RISK] = event.risk_score
        features[FeatureIndex.USER_RESPONSE_RATE] = trip_details.user_response_rate
        features[FeatureIndex.PREVIOUS_INCIDENTS] = self.normalize(
            trip_details.previous_incidents, 0, 10
        )
        
        # 12-14: Context
        features[FeatureIndex.WEATHER] = self.map_weather(event.weather)
        features[FeatureIndex.COUNTRY_RISK] = self.map_country_risk(trip_details.country)
        features[FeatureIndex.TIME_SINCE_LAST_UPDATE] = self.normalize(
            event.time_since_last_update, 0, 300
        )
        
        # 15-19: Behavioral & Environmental
        features[FeatureIndex.USER_BEHAVIOR_PATTERN] = trip_details.behavior_score
        features[FeatureIndex.TRIP_TYPE] = self.calculate_trip_type(now, trip_details)
        features[FeatureIndex.CROWD_DENSITY] = event.crowd_density
        features[FeatureIndex.NEARBY_EVENTS] = self.normalize(
            event.nearby_events_count, 0, 5
        )
        features[FeatureIndex.ROUTE_COMPLEXITY] = event.route_complexity
        
        # 20-24: Guide & Tourist ratings (neutralize for solo trips)
        guide_safety = 5 if is_solo else extended_data.guide_safety_score
        guide_review = 5 if is_solo else extended_data.guide_review_rating
        guide_success = 1.0 if is_solo else extended_data.guide_success_rate
        
        features[FeatureIndex.GUIDE_RATING] = guide_safety / 5.0
        features[FeatureIndex.GUIDE_SUCCESS_RATE] = guide_success
        features[FeatureIndex.GUIDE_REVIEW_RATING] = guide_review / 5.0
        features[FeatureIndex.TOURIST_RATING] = extended_data.tourist_rating / 5.0
        features[FeatureIndex.DESTINATION_POPULARITY] = extended_data.destination_popularity
        
        # 25-26: User Preferences
        features[FeatureIndex.USER_SENTIMENT] = extended_data.avg_sentiment
        features[FeatureIndex.PREFERS_FEWER_MESSAGES] = (
            1.0 if extended_data.prefers_fewer_messages else 0.0
        )
        
        # 🆕 27-34: User Profile Features from EmergencyAlert, Chat, Review
        # These features are passed from the JS client via extended_data or user_profiles
        user_profiles = getattr(extended_data, 'user_profiles', None)
        if user_profiles:
            tourist_profile = user_profiles.get('tourist', {})
            ml_features = tourist_profile.get('ml_features', {})
            emergency_history = tourist_profile.get('emergency_history', {})
            experience = tourist_profile.get('experience', {})
            
            # Trust and risk scores
            features[FeatureIndex.USER_TRUST_SCORE] = ml_features.get('trustNormalized', 0.5)
            features[FeatureIndex.USER_RISK_SCORE] = ml_features.get('riskNormalized', 0.3)
            
            # Emergency history (from EmergencyAlert model)
            features[FeatureIndex.EMERGENCY_HISTORY_COUNT] = self.normalize(
                emergency_history.get('total_incidents', 0), 0, 10
            )
            features[FeatureIndex.HAS_UNRESOLVED_EMERGENCY] = (
                1.0 if emergency_history.get('has_unresolved', False) else 0.0
            )
            
            # Chat behavior (from Chat model)
            communication = tourist_profile.get('communication', {})
            features[FeatureIndex.CHAT_EMERGENCY_RATE] = (
                1.0 if communication.get('uses_emergency_keywords', False) else 0.0
            )
            
            # Review rating (from Review model)
            ratings = tourist_profile.get('ratings', {})
            avg_received = ratings.get('avg_received', 4.0)
            features[FeatureIndex.REVIEW_AVG_RECEIVED] = (
                (avg_received or 4.0) / 5.0 if avg_received else 0.8
            )
            
            # Experience (from order history)
            features[FeatureIndex.EXPERIENCE_TOTAL_TRIPS] = self.normalize(
                experience.get('total_trips', 0), 0, 50
            )
            features[FeatureIndex.EXPERIENCE_INCIDENT_RATE] = experience.get('incident_rate', 0.0)
        else:
            # Default values when profiles not available
            features[FeatureIndex.USER_TRUST_SCORE] = 0.5
            features[FeatureIndex.USER_RISK_SCORE] = 0.3
            features[FeatureIndex.EMERGENCY_HISTORY_COUNT] = 0.0
            features[FeatureIndex.HAS_UNRESOLVED_EMERGENCY] = 0.0
            features[FeatureIndex.CHAT_EMERGENCY_RATE] = 0.0
            features[FeatureIndex.REVIEW_AVG_RECEIVED] = 0.8
            features[FeatureIndex.EXPERIENCE_TOTAL_TRIPS] = 0.0
            features[FeatureIndex.EXPERIENCE_INCIDENT_RATE] = 0.0
        
        return features
    
    def extract_features_batch(
        self,
        events: List[SafetyEvent],
        trip_details_list: List[TripDetails],
        extended_data_list: Optional[List[ExtendedData]] = None
    ) -> np.ndarray:
        """
        Vectorized batch feature extraction
        Returns: numpy array of shape (batch_size, input_features)
        """
        batch_size = len(events)
        features_batch = np.zeros((batch_size, self.feature_count), dtype=np.float32)
        
        if extended_data_list is None:
            extended_data_list = [ExtendedData() for _ in range(batch_size)]
        
        for i in range(batch_size):
            features_batch[i] = self.extract_features(
                events[i],
                trip_details_list[i],
                extended_data_list[i]
            )
        
        return features_batch
    
    @staticmethod
    def add_cyclical_encoding(
        features: np.ndarray,
        hour_idx: int = FeatureIndex.HOUR,
        day_idx: int = FeatureIndex.DAY_OF_WEEK
    ) -> np.ndarray:
        """
        Add cyclical (sin/cos) encoding for temporal features
        This is a more robust representation for time-based features
        """
        hour_norm = features[hour_idx]
        day_norm = features[day_idx]
        
        # Convert back to original values
        hour = hour_norm * 23
        day = day_norm * 6
        
        # Cyclical encoding
        hour_sin = math.sin(2 * math.pi * hour / 24)
        hour_cos = math.cos(2 * math.pi * hour / 24)
        day_sin = math.sin(2 * math.pi * day / 7)
        day_cos = math.cos(2 * math.pi * day / 7)
        
        # Replace original values (or you could append new features)
        features[hour_idx] = (hour_sin + 1) / 2  # Normalize to [0, 1]
        features[day_idx] = (day_sin + 1) / 2
        
        return features


# Module-level instance
preprocessor = DataPreprocessor()
