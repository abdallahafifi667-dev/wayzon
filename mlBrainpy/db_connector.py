"""
MongoDB Database Connector for Python ML Brain
Provides access to all models in the Trip Monitoring system for training and learning
"""

import os
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
from motor.motor_asyncio import AsyncIOMotorClient
import logging

logger = logging.getLogger(__name__)

# MongoDB Connection URL (from environment or default)
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("MONGODB_DB_NAME", "tripMonitoring")


class DatabaseConnector:
    """
    Async MongoDB connector for ML Brain
    
    Provides access to all collections:
    - Users (ratings, behavior, preferences)
    - Orders (trips, routes, outcomes)
    - Reviews (guide/tourist ratings)
    - Chat (message sentiment)
    - SafetyEvents (training data)
    - TripFeedback (outcomes & labels)
    """
    
    def __init__(self):
        self.client: Optional[AsyncIOMotorClient] = None
        self.db = None
        self.is_connected = False
    
    async def connect(self) -> bool:
        """Establish connection to MongoDB"""
        try:
            self.client = AsyncIOMotorClient(MONGODB_URI)
            self.db = self.client[DB_NAME]
            
            # Test connection
            await self.db.command("ping")
            self.is_connected = True
            logger.info(f"Connected to MongoDB: {DB_NAME}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to connect to MongoDB: {e}")
            self.is_connected = False
            return False
    
    async def disconnect(self):
        """Close MongoDB connection"""
        if self.client:
            self.client.close()
            self.is_connected = False
            logger.info("Disconnected from MongoDB")
    
    # ==================== Training Data ====================
    
    async def get_training_data(
        self,
        days: int = 90,
        limit: int = 50000
    ) -> List[Dict[str, Any]]:
        """
        Fetch training data from SafetyTrainingData collection
        
        Returns raw data for feature extraction
        """
        if not self.is_connected:
            await self.connect()
        
        cutoff = datetime.now() - timedelta(days=days)
        
        cursor = self.db.safetytrainingdatas.find(
            {"createdAt": {"$gte": cutoff}},
            {"rawData": 1, "label": 1, "metadata": 1, "eventId": 1}
        ).sort("createdAt", -1).limit(limit)
        
        return await cursor.to_list(length=limit)
    
    async def get_safety_events(
        self,
        trip_id: Optional[str] = None,
        days: int = 30
    ) -> List[Dict[str, Any]]:
        """Fetch safety events for analysis"""
        if not self.is_connected:
            await self.connect()
        
        query = {"createdAt": {"$gte": datetime.now() - timedelta(days=days)}}
        if trip_id:
            query["tripId"] = trip_id
        
        cursor = self.db.safetyevents.find(query).sort("createdAt", -1).limit(1000)
        return await cursor.to_list(length=1000)
    
    async def get_outcomes(self, event_ids: List[str]) -> List[Dict[str, Any]]:
        """Fetch outcomes for training label refinement"""
        if not self.is_connected:
            await self.connect()
        
        from bson import ObjectId
        oid_list = [ObjectId(eid) for eid in event_ids if len(eid) == 24]
        
        cursor = self.db.safetyoutcomes.find({"eventId": {"$in": oid_list}})
        return await cursor.to_list(length=len(oid_list))
    
    # ==================== User Data ====================
    
    async def get_user_stats(self, user_id: str) -> Dict[str, Any]:
        """
        Get comprehensive user statistics for feature enrichment
        
        Aggregates data from:
        - User profile (ratings, behavior)
        - Orders (success rate, incident count)
        - Reviews (average rating)
        - Feedback (trust score, sentiment)
        """
        if not self.is_connected:
            await self.connect()
        
        from bson import ObjectId
        try:
            oid = ObjectId(user_id)
        except:
            return {}
        
        # User profile
        user = await self.db.users.find_one(
            {"_id": oid},
            {"username": 1, "role": 1, "safetyConfig": 1, "createdAt": 1}
        )
        
        if not user:
            return {}
        
        # Order statistics
        orders = await self.db.orders.aggregate([
            {"$match": {"$or": [{"guide": oid}, {"normal": oid}]}},
            {"$group": {
                "_id": None,
                "total": {"$sum": 1},
                "completed": {"$sum": {"$cond": [{"$eq": ["$status", "completed"]}, 1, 0]}},
                "incidents": {"$sum": {"$cond": [{"$eq": ["$hadIncident", True]}, 1, 0]}}
            }}
        ]).to_list(1)
        
        order_stats = orders[0] if orders else {"total": 0, "completed": 0, "incidents": 0}
        
        # Reviews
        reviews = await self.db.reviews.aggregate([
            {"$match": {"user": oid}},
            {"$group": {"_id": None, "avgRating": {"$avg": "$rating"}, "count": {"$sum": 1}}}
        ]).to_list(1)
        
        review_stats = reviews[0] if reviews else {"avgRating": 5.0, "count": 0}
        
        # Trust score from feedback
        feedback = await self.db.tripfeedbacks.aggregate([
            {"$match": {"$or": [{"fromUser": oid}, {"toUser": oid}]}},
            {"$group": {
                "_id": None,
                "avgSafety": {"$avg": "$safetyRating"},
                "avgSentiment": {"$avg": "$sentiment"},
                "count": {"$sum": 1}
            }}
        ]).to_list(1)
        
        feedback_stats = feedback[0] if feedback else {"avgSafety": 5.0, "avgSentiment": 0.5, "count": 0}
        
        return {
            "user_id": user_id,
            "role": user.get("role"),
            "safety_plan": user.get("safetyConfig", {}).get("plan", "free"),
            "success_rate": order_stats["completed"] / max(1, order_stats["total"]),
            "incident_count": order_stats["incidents"],
            "avg_rating": review_stats["avgRating"],
            "review_count": review_stats["count"],
            "trust_score": feedback_stats["avgSafety"] / 5.0,
            "sentiment": feedback_stats.get("avgSentiment", 0.5),
            "total_feedback": feedback_stats["count"]
        }
    
    async def get_guide_stats(self, guide_id: str) -> Dict[str, Any]:
        """Get guide-specific statistics for ML features"""
        return await self.get_user_stats(guide_id)
    
    async def get_tourist_stats(self, tourist_id: str) -> Dict[str, Any]:
        """Get tourist-specific statistics for ML features"""
        return await self.get_user_stats(tourist_id)
    
    # ==================== Trip Context ====================
    
    async def get_trip_context(self, trip_id: str) -> Dict[str, Any]:
        """
        Get full trip context for decision making
        
        Includes: route, locations, participants, status
        """
        if not self.is_connected:
            await self.connect()
        
        from bson import ObjectId
        try:
            oid = ObjectId(trip_id)
        except:
            return {}
        
        trip = await self.db.orders.find_one({"_id": oid})
        
        if not trip:
            return {}
        
        # Get participant stats
        guide_stats = await self.get_guide_stats(str(trip.get("guide", ""))) if trip.get("guide") else {}
        tourist_stats = await self.get_tourist_stats(str(trip.get("normal", ""))) if trip.get("normal") else {}
        
        return {
            "trip_id": trip_id,
            "service_type": trip.get("serviceType", "guided"),
            "destination_country": trip.get("destinationCountry"),
            "status": trip.get("status"),
            "locations": trip.get("locations", []),
            "guide_stats": guide_stats,
            "tourist_stats": tourist_stats,
            "expected_duration": trip.get("expectedDuration", 0),
            "safety_config": trip.get("safetyConfig", {})
        }
    
    # ==================== Historical Aggregations ====================
    
    async def get_historical_stats(self) -> Dict[str, Any]:
        """
        Get pre-aggregated statistics for training enrichment
        
        Returns stats for:
        - Guides (ratings, success rates)
        - Destinations (popularity, risk scores)
        - Tourists (behavior patterns)
        """
        if not self.is_connected:
            await self.connect()
        
        # Guide stats aggregation
        guide_stats = {}
        guide_cursor = self.db.users.aggregate([
            {"$match": {"role": "guide"}},
            {"$lookup": {
                "from": "reviews",
                "localField": "_id",
                "foreignField": "user",
                "as": "reviews"
            }},
            {"$lookup": {
                "from": "orders",
                "localField": "_id",
                "foreignField": "guide",
                "as": "orders"
            }},
            {"$project": {
                "avgRating": {"$avg": "$reviews.rating"},
                "totalOrders": {"$size": "$orders"},
                "completedOrders": {
                    "$size": {
                        "$filter": {
                            "input": "$orders",
                            "cond": {"$eq": ["$$this.status", "completed"]}
                        }
                    }
                }
            }}
        ])
        
        async for doc in guide_cursor:
            guide_stats[str(doc["_id"])] = {
                "guide_rating": doc.get("avgRating", 5.0) or 5.0,
                "guide_success_rate": doc["completedOrders"] / max(1, doc["totalOrders"]),
                "review_rating": doc.get("avgRating", 5.0) or 5.0
            }
        
        # Destination popularity
        destination_stats = {}
        dest_cursor = self.db.orders.aggregate([
            {"$group": {
                "_id": "$destinationCountry",
                "count": {"$sum": 1},
                "avgRisk": {"$avg": "$riskScore"}
            }}
        ])
        
        total_orders = await self.db.orders.count_documents({})
        
        async for doc in dest_cursor:
            if doc["_id"]:
                destination_stats[doc["_id"]] = {
                    "popularity": min(1.0, doc["count"] / max(1, total_orders) * 10),
                    "avg_risk": doc.get("avgRisk", 0.5) or 0.5
                }
        
        return {
            "guides": guide_stats,
            "destinations": destination_stats,
            "total_orders": total_orders
        }


# Module-level singleton
db_connector = DatabaseConnector()
