"""
Motion Trajectory Brain - Advanced Trajectory Prediction
Predicts user movement with configurable horizon and performs "Silent Vetting"
"""

import math
import numpy as np
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime
from dataclasses import dataclass, field
import logging

logger = logging.getLogger(__name__)


# Configuration constants
PREDICTION_HORIZON_MINUTES = 30
HISTORY_WINDOW_SIZE = 15
TOLERANCE_THRESHOLD = 0.7


@dataclass
class MotionPoint:
    """A point in motion history"""
    coordinates: Tuple[float, float]
    speed: float
    timestamp: float = field(default_factory=lambda: datetime.now().timestamp())


@dataclass
class GoalVetting:
    """Result of goal/POI vetting"""
    is_logical: bool = False
    reasons: List[str] = field(default_factory=list)
    location_name: str = ""
    is_tourist_area: bool = False
    confidence: float = 0.0


@dataclass
class RejoiningAnalysis:
    """Result of route rejoining analysis"""
    rejoins: bool = False
    target: str = ""
    confidence: float = 0.0
    distance_remaining: float = float('inf')


@dataclass
class TrajectoryAnalysis:
    """Complete trajectory analysis result"""
    status: str = "analyzed"
    prediction: Dict[str, Any] = field(default_factory=dict)
    goal_vetting: GoalVetting = field(default_factory=GoalVetting)
    rejoining_analysis: RejoiningAnalysis = field(default_factory=RejoiningAnalysis)
    tolerance_score: float = 0.0
    should_wait: bool = False
    reasoning: str = ""


class MotionTrajectoryBrain:
    """
    Advanced Intelligence Layer for Motion Trajectory Analysis
    
    Capabilities:
    - Vector-based future position projection
    - POI (Point of Interest) goal vetting
    - Route rejoining probability estimation
    - Speed trend analysis
    - Intelligent tolerance scoring
    """
    
    def __init__(self):
        self._history_cache: Dict[str, List[MotionPoint]] = {}
    
    async def analyze_trajectory(
        self,
        trip_id: str,
        current_coordinates: Tuple[float, float],
        speed: float,
        bearing: float,
        trip_details: Dict[str, Any],
        map_verifier=None,
        state_manager=None
    ) -> TrajectoryAnalysis:
        """
        Main Analysis Entry Point
        
        Args:
            trip_id: Unique trip identifier
            current_coordinates: Current (longitude, latitude)
            speed: Current speed in km/h
            bearing: Current heading in degrees
            trip_details: Trip context including planned locations
            map_verifier: Optional map verification service
            state_manager: Optional state persistence service
            
        Returns:
            Complete trajectory analysis
        """
        # 1. Update short-term movement history
        history = await self._update_history(
            trip_id, 
            current_coordinates, 
            speed, 
            state_manager
        )
        
        # 2. Linear projection (short-term: 15 mins)
        short_projection = self.project_vector(
            current_coordinates, 
            bearing, 
            speed, 
            15
        )
        
        # 3. Strategic projection (long-term: configurable horizon)
        strategic_projection = self.project_vector(
            current_coordinates, 
            bearing, 
            speed, 
            PREDICTION_HORIZON_MINUTES
        )
        
        # 4. Goal recognition & POI vetting
        goal_vetting = await self._vet_potential_destinations(
            strategic_projection, 
            trip_details,
            map_verifier
        )
        
        # 5. Route rejoining analysis
        rejoining_analysis = await self._check_rejoining_probability(
            strategic_projection, 
            trip_details
        )
        
        # 6. Calculate tolerance score
        tolerance_score = self._calculate_tolerance(
            goal_vetting, 
            rejoining_analysis, 
            speed, 
            history
        )
        
        return TrajectoryAnalysis(
            status="analyzed",
            prediction={
                "short_term": short_projection,
                "long_term": strategic_projection,
                "horizon": PREDICTION_HORIZON_MINUTES
            },
            goal_vetting=goal_vetting,
            rejoining_analysis=rejoining_analysis,
            tolerance_score=tolerance_score,
            should_wait=tolerance_score > TOLERANCE_THRESHOLD,
            reasoning=self._generate_reasoning(
                goal_vetting, 
                rejoining_analysis, 
                tolerance_score
            )
        )
    
    def project_vector(
        self,
        coords: Tuple[float, float],
        bearing: float,
        speed: float,
        minutes: int
    ) -> Tuple[float, float]:
        """
        Calculate future point based on movement vector using Haversine formula
        
        Args:
            coords: Current (longitude, latitude)
            bearing: Heading in degrees (0 = North, 90 = East)
            speed: Speed in km/h
            minutes: Time horizon in minutes
            
        Returns:
            Projected (longitude, latitude)
        """
        if speed <= 0 or bearing is None:
            return coords
        
        R = 6371e3  # Earth radius in meters
        lon1, lat1 = coords
        
        # Convert to radians
        lon1_rad = math.radians(lon1)
        lat1_rad = math.radians(lat1)
        bearing_rad = math.radians(bearing)
        
        # Distance in meters: (speed km/h → m/s) × (minutes → seconds)
        distance = (speed / 3.6) * (minutes * 60)
        
        # Haversine destination formula
        lat2_rad = math.asin(
            math.sin(lat1_rad) * math.cos(distance / R) +
            math.cos(lat1_rad) * math.sin(distance / R) * math.cos(bearing_rad)
        )
        
        lon2_rad = lon1_rad + math.atan2(
            math.sin(bearing_rad) * math.sin(distance / R) * math.cos(lat1_rad),
            math.cos(distance / R) - math.sin(lat1_rad) * math.sin(lat2_rad)
        )
        
        # Normalize longitude to [-180, 180]
        lon2 = (math.degrees(lon2_rad) + 540) % 360 - 180
        lat2 = math.degrees(lat2_rad)
        
        return (lon2, lat2)
    
    async def _vet_potential_destinations(
        self,
        projected_point: Tuple[float, float],
        trip_details: Dict[str, Any],
        map_verifier=None
    ) -> GoalVetting:
        """
        Search for logical POIs along/near the projected trajectory
        """
        try:
            if map_verifier is None:
                # Return neutral result without external verification
                return GoalVetting(is_logical=False, confidence=0.0)
            
            # Call external map verification service
            search = await map_verifier.verify_location(projected_point)
            
            if search.get("status") == "verified" and search.get("safety_level") == "safe":
                reasons = search.get("possible_stop_reasons", [])
                return GoalVetting(
                    is_logical=len(reasons) > 0,
                    reasons=reasons,
                    location_name=search.get("address", ""),
                    is_tourist_area=search.get("is_tourist_area", False),
                    confidence=0.8 if reasons else 0.4
                )
                
        except Exception as e:
            logger.debug(f"Goal vetting failed: {e}")
        
        return GoalVetting(is_logical=False, confidence=0.0)
    
    async def _check_rejoining_probability(
        self,
        projected_point: Tuple[float, float],
        trip_details: Dict[str, Any]
    ) -> RejoiningAnalysis:
        """
        Check if the current trajectory intersects with the planned route later
        """
        locations = trip_details.get("locations", [])
        if not locations:
            return RejoiningAnalysis(rejoins=False, confidence=0.0)
        
        nearest = None
        min_dist = float('inf')
        
        for loc in locations:
            loc_coords = loc.get("coordinates")
            if not loc_coords:
                continue
            
            if isinstance(loc_coords, dict):
                loc_coords = (loc_coords.get("lng", 0), loc_coords.get("lat", 0))
            elif isinstance(loc_coords, list) and len(loc_coords) >= 2:
                loc_coords = tuple(loc_coords[:2])
            else:
                continue
            
            dist = self._calculate_distance(projected_point, loc_coords)
            if dist < min_dist:
                min_dist = dist
                nearest = loc
        
        # If projected head is within 1km of a future location, high rejoin probability
        if min_dist < 1000 and nearest:
            return RejoiningAnalysis(
                rejoins=True,
                target=nearest.get("name", "Unknown location"),
                confidence=0.9,
                distance_remaining=min_dist
            )
        
        return RejoiningAnalysis(rejoins=False, confidence=0.1)
    
    async def _update_history(
        self,
        trip_id: str,
        coordinates: Tuple[float, float],
        speed: float,
        state_manager=None
    ) -> List[MotionPoint]:
        """
        Manage short-term breadcrumb history
        """
        # Use external state manager if available
        if state_manager:
            try:
                state = await state_manager.get_trip_state(trip_id) or {}
                history_data = state.get("motion_history", [])
                history = [
                    MotionPoint(
                        coordinates=tuple(h["coordinates"]),
                        speed=h["speed"],
                        timestamp=h["timestamp"]
                    )
                    for h in history_data
                ]
            except Exception:
                history = []
        else:
            # Use in-memory cache
            history = self._history_cache.get(trip_id, [])
        
        # Add new point
        new_point = MotionPoint(
            coordinates=coordinates,
            speed=speed,
            timestamp=datetime.now().timestamp()
        )
        history.append(new_point)
        
        # Trim to window size
        if len(history) > HISTORY_WINDOW_SIZE:
            history = history[-HISTORY_WINDOW_SIZE:]
        
        # Persist
        if state_manager:
            try:
                history_data = [
                    {
                        "coordinates": list(h.coordinates),
                        "speed": h.speed,
                        "timestamp": h.timestamp
                    }
                    for h in history
                ]
                await state_manager.update_trip_state(trip_id, {"motion_history": history_data})
            except Exception as e:
                logger.debug(f"Failed to persist motion history: {e}")
        else:
            self._history_cache[trip_id] = history
        
        return history
    
    def _calculate_tolerance(
        self,
        goal_vetting: GoalVetting,
        rejoining_analysis: RejoiningAnalysis,
        speed: float,
        history: List[MotionPoint]
    ) -> float:
        """
        Calculate how much we should tolerate this deviation
        
        Higher score = more tolerant of current deviation
        """
        score = 0.0
        
        # Path rejoining is the strongest reason to tolerate
        if rejoining_analysis.rejoins:
            score += 0.6 * rejoining_analysis.confidence
        
        # Logical POIs (Cafe/Gas station/etc.)
        if goal_vetting.is_logical:
            score += 0.4 * goal_vetting.confidence
        
        # Constant speed trend suggests intentional movement, not distress
        speed_trend = self._analyze_speed_trend(history)
        if speed_trend == "stable":
            score += 0.2
        elif speed_trend == "erratic":
            score -= 0.1  # Penalize erratic movement
        
        return max(0.0, min(1.0, score))
    
    def _analyze_speed_trend(self, history: List[MotionPoint]) -> str:
        """
        Analyze recent speed patterns
        
        Returns:
            'stable' | 'accelerating' | 'decelerating' | 'erratic'
        """
        if len(history) < 5:
            return "stable"
        
        recent = history[-5:]
        speeds = [p.speed for p in recent]
        avg = sum(speeds) / len(speeds)
        variance = sum((s - avg) ** 2 for s in speeds) / len(speeds)
        
        if variance < 2:
            return "stable"
        
        # Check trend direction
        if speeds[-1] > speeds[0] + 5:
            return "accelerating"
        if speeds[-1] < speeds[0] - 5:
            return "decelerating"
        
        return "erratic"
    
    def _generate_reasoning(
        self,
        goal_vetting: GoalVetting,
        rejoining: RejoiningAnalysis,
        score: float
    ) -> str:
        """Generate human-readable reasoning for the tolerance decision"""
        if score > TOLERANCE_THRESHOLD:
            if rejoining.rejoins:
                return f"Trajectory suggests user is detouring but heading back to {rejoining.target}."
            if goal_vetting.is_logical:
                return f"Trajectory points towards a safe logical stop: {goal_vetting.location_name}."
            return "Movement patterns suggest intentional but off-route logic."
        
        return "Deviation does not match any logical trajectory or future destination."
    
    @staticmethod
    def _calculate_distance(
        point1: Tuple[float, float],
        point2: Tuple[float, float]
    ) -> float:
        """
        Calculate distance between two points using Haversine formula
        
        Returns:
            Distance in meters
        """
        R = 6371e3  # Earth radius in meters
        
        lon1, lat1 = point1
        lon2, lat2 = point2
        
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        delta_phi = math.radians(lat2 - lat1)
        delta_lambda = math.radians(lon2 - lon1)
        
        a = (math.sin(delta_phi / 2) ** 2 +
             math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        
        return R * c
    
    def clear_history(self, trip_id: str):
        """Clear motion history for a trip (e.g., when trip ends)"""
        self._history_cache.pop(trip_id, None)


# Module-level instance
motion_trajectory_brain = MotionTrajectoryBrain()
