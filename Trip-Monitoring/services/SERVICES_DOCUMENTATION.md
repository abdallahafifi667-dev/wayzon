# 📚 Trip Monitoring Services - Complete Documentation

> وصف شامل لكل السيرفيسات | Last Updated: 2026-01-12

---

## 🏗️ System Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     API Controllers                          │
│                  (Location Updates, Trips)                   │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              safetyOrchestrator.js (Main Entry)              │
│         Coordinates all safety layers and decisions          │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  ML Layer     │  │  Map Layer    │  │   AI Layer    │
│  (mlAnalyzer) │  │  (mapVerifier)│  │  (aiAnalyzer) │
└───────────────┘  └───────────────┘  └───────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
         ┌─────────────────────────────────────┐
         │     decisionOrchestrationService     │
         │      (Final Decision Playbooks)      │
         └─────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         Notifications   Escalation   State Update
```

---

## 📁 Services Directory Structure

```
services/
├── safetyOrchestrator.js      # Main safety coordinator
├── tripStateManager.js        # Redis-based state management
├── tripScheduler.js           # Trip scheduling
├── tripCompletionService.js   # Auto trip completion
├── tripFeedbackService.js     # Post-trip feedback & learning
├── tripEventEmitter.js        # Event emission
├── timerManager.js            # Scheduled timers
├── notificationQueueService.js # Smart notification queue
├── flexibleResponseService.js # User response handling
├── meetingPointService.js     # Meeting point logic
├── externalSafetyRulesService.js # External rules
├── initServices.js            # Service initialization
│
├── mlBrain/                   # JavaScript ML Client
│   ├── index.js               # Python ML Brain HTTP client
│   ├── config.js              # Configuration
│   └── MotionTrajectoryBrain.js # Motion prediction
│
mlBrainpy/                      # Python ML Brain Service (Root Level)
├── __init__.py                # Main MLBrain class
├── api.py                     # FastAPI endpoints
├── neural_network.py          # TensorFlow model
├── trainer.py                 # Training pipeline
├── decision_engine.py         # Decision making
└── ...                        # Other ML components
│
└── safety/                    # Safety Analysis Layers
    ├── mlAnalyzer.js          # Layer 1: ML decisions
    ├── mapVerifier.js         # Layer 2: Map verification
    ├── aiAnalyzer.js          # Layer 3: AI context analysis
    ├── distanceMonitor.js     # Layer 5: Distance tracking
    ├── speedAnalyzer.js       # Speed analysis
    ├── routeMonitor.js        # Layer 9: Route monitoring
    ├── deviceHealthMonitor.js # Device health
    ├── locationReputationService.js # Layer 11: Web reputation
    ├── videoRiskAnalyzer.js   # Video/news threat detection
    ├── escalationService.js   # Admin escalation
    ├── temporalRiskService.js # Time-based risks
    ├── spatialRiskEngine.js   # Spatial risk analysis
    ├── decisionOrchestrationService.js # Layer 15: Playbooks
    ├── dataCollector.js       # ML data collection
    └── helper/                # Helper utilities
```

---

## 🔧 Core Services

### 1. safetyOrchestrator.js

**المنسق الرئيسي للأمان**

**Purpose:** Main entry point for all safety analysis. Coordinates multiple analysis layers and produces final decisions.

**Main Functions:**
| Function | Description |
|----------|-------------|
| `processLocationUpdate(tripId, role, coords, tripDetails)` | Processes incoming location updates and runs all safety layers |
| `processUserResponse(tripId, userId, response)` | Handles user responses to safety questions |
| `getTripDetails(tripId)` | Fetches trip details from database |

**API Usage:**

```javascript
const safetyOrchestrator = require('./services/safetyOrchestrator');

// Called by location controller
const result = await safetyOrchestrator.processLocationUpdate(
  tripId,
  'tourist',     // 'tourist' or 'guide'
  [31.235, 30.044],  // [longitude, latitude]
  tripDetails
);

// Response structure:
{
  status: 'safe' | 'monitored' | 'optimized',
  decision: { playbook: 'PROCEED' | 'REROUTE' | 'CRITICAL_ADVISORY', ... },
  ml: { riskLevel, riskScore, confidence },
  temporal: { riskLevel, legalStatus },
  spatial: { riskLevel },
  ai: { status, details }
}
```

**Database Models Used:**

- ✅ `Order` - Trip details
- ✅ `User` - User info and FCM tokens
- ✅ `SafetyEvent` - Via dataCollector

---

### 2. tripStateManager.js

**إدارة حالة الرحلات**

**Purpose:** Manages real-time trip state in Redis. Stores locations, meeting status, and analysis results.

**Main Functions:**
| Function | Description |
|----------|-------------|
| `getOrCreateTripState(tripId)` | Gets or creates initial trip state |
| `updateLocation(tripId, role, coords)` | Updates user location with atomic operations |
| `getDistance(tripId)` | Calculates distance between tourist and guide |
| `setMeetingStatus(tripId, hasMet)` | Marks meeting point reached |
| `setEscalationLevel(tripId, level)` | Sets current escalation level |

**API Usage:**

```javascript
const tripStateManager = require("./services/tripStateManager");

// Get trip state
const state = await tripStateManager.getTripState(tripId);

// Update location (uses Redis WATCH for atomicity)
await tripStateManager.updateLocation(tripId, "tourist", [31.23, 30.04]);

// Calculate Haversine distance
const meters = tripStateManager.calculateDistance(coord1, coord2);
```

**Redis Keys:**

- `trip:state:{tripId}` - Full trip state (24h TTL)
- `trip:location:{tripId}:guide` - Guide location
- `trip:location:{tripId}:normal` - Tourist location

**Database Models Used:**

- ❌ None (Redis only)

---

### 3. mlBrain/index.js (JavaScript Client)

**عميل ML Brain للتواصل مع خدمة Python**

**Purpose:** HTTP client that communicates with the Python ML Brain FastAPI service.

**Main Functions:**
| Function | Description |
|----------|-------------|
| `init()` | Initializes connection to Python service |
| `getSafetyProposal(event, tripDetails)` | Gets safety decision from ML |
| `learn(event, tripDetails)` | Submits learning data |
| `getMaturityStatus()` | Gets ML maturity level |
| `isReadyForAutonomous()` | Checks if ML is ready for autonomous decisions |

**API Usage:**

```javascript
const mlBrain = require('./services/mlBrain');

// Initialize
await mlBrain.init();

// Get safety proposal
const decision = await mlBrain.getSafetyProposal({
  coordinates: [31.23, 30.04],
  speed: 45,
  deviceHealth: { battery: 80, signal: 4 }
}, tripDetails);

// Response structure:
{
  riskScore: 0.35,
  riskLevel: 'caution',
  mustUseMaps: true,
  mustUseAI: false,
  confidence: 0.72,
  suggestedLayers: ['map_verification'],
  decisionSource: 'ml_brain_py'
}
```

**Fallback Mode:**
When Python service is unavailable, returns:

```javascript
{
  decision: 'fallback',
  useLegacy: true,
  mustUseMaps: true,
  mustUseAI: true
}
```

**Database Models Used:**

- ❌ None (HTTP client only)

---

### 4. tripFeedbackService.js

**خدمة تقييم ما بعد الرحلة**

**Purpose:** Collects post-trip feedback and uses it to improve ML predictions. Implements adaptive trust scoring.

**Main Functions:**
| Function | Description |
|----------|-------------|
| `requestFeedback(tripId, tripDetails)` | Sends feedback request to both parties |
| `submitFeedback(tripId, userId, data)` | Processes submitted feedback |
| `getUserTrustScore(userId)` | Gets trust score and monitoring intensity |
| `scheduleFeedbackRequest(tripId, tripDetails)` | Schedules feedback after trip |

**API Usage:**

```javascript
const tripFeedbackService = require('./services/tripFeedbackService');

// Get user trust for adaptive monitoring
const trust = await tripFeedbackService.getUserTrustScore(userId);
// Returns:
{
  trustScore: 75,
  totalFeedback: 12,
  incidentCount: 0,
  monitoringIntensity: 'low',  // 'high' | 'normal' | 'low' | 'very_low'
  recommendation: {
    checkFrequency: 'reduced',
    aiAnalysisThreshold: 0.7,
    skipMLLayer: true
  }
}

// Submit feedback
await tripFeedbackService.submitFeedback(tripId, userId, {
  rating: 5,
  safety_rating: 4,
  had_incident: false,
  would_recommend: true,
  comments: "Great trip!"
});
```

**Database Models Used:**

- ✅ `TripFeedback` - Stores feedback data
- ✅ `SafetyEvent` - Updates training labels
- ✅ `Order` - Trip info
- ✅ `User` - User details

---

### 5. notificationQueueService.js

**قائمة الإشعارات الذكية**

**Purpose:** Smart notification management with rate limiting, deduplication, quiet hours, and priority queuing.

**Main Functions:**
| Function | Description |
|----------|-------------|
| `queueNotification(notification)` | Adds notification to queue |
| `setQuietHours(userId, start, end, timezone)` | Sets user quiet hours |
| `getStats()` | Gets queue statistics |

**API Usage:**

```javascript
const notificationQueue = require('./services/notificationQueueService');

// Queue a notification
const result = await notificationQueue.queueNotification({
  userId: 'user123',
  title: '⚠️ Safety Alert',
  body: 'You are entering a risky area',
  data: { tripId, type: 'reputation_warning', riskLevel: 'high' },
  priority: 'HIGH',  // 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'
  dedupe: true,
  bypassQuietHours: false
});

// Possible responses:
{ status: 'queued', id: 'abc123', position: 1 }
{ status: 'deduplicated' }  // Already sent this trip
{ status: 'quiet_hours' }   // User in quiet hours
```

**Features:**

- **Rate Limiting:** 10/minute, 50/hour per user
- **Sticky Alerts:** Same hazard only alerted once per trip (unless severity increases)
- **Quiet Hours:** Respects user sleep preferences
- **Priority Queue:** URGENT notifications bypass limits

**Database Models Used:**

- ✅ `TripNotificationHistory` - Persistent notification log
- ✅ `User` - For FCM tokens

---

## 🔒 Safety Layer Services

### 6. safety/mlAnalyzer.js

**Layer 1: ML Decision Engine**

**Purpose:** JavaScript-based ML analysis using historical data. Decides which layers to activate.

**API Usage:**

```javascript
const mlAnalyzer = require('./services/safety/mlAnalyzer');

const result = await mlAnalyzer.analyzeLocation(tripId, [31.23, 30.04], 'tourist');
// Returns:
{
  status: 'analyzed',
  riskLevel: 'caution',
  riskScore: 45,
  confidence: 68,
  suggestedLayers: [2, 3],  // Which layers to run
  recommendation: 'use_map_verification'
}
```

**Database Models Used:**

- ✅ `SafetyEvent` - Historical events for learning

---

### 7. safety/mapVerifier.js

**Layer 2: Map Verification**

**Purpose:** Multi-provider map verification. Supports Google, OSM, Baidu, Yandex, HERE.

**API Usage:**

```javascript
const mapVerifier = require('./services/safety/mapVerifier');

// Verify location safety
const result = await mapVerifier.verifyLocation([31.23, 30.04], context);
// Returns:
{
  status: 'verified',
  provider: 'osm',
  address: 'Tahrir Square, Cairo',
  locationType: 'tourist',
  safetyLevel: 'safe',
  isTouristArea: true,
  hasEmergencyServices: true,
  possibleStopReasons: ['sightseeing'],
  nearbyPlaces: { safe: [...], risky: [...] }
}

// Reverse geocode
const geo = await mapVerifier.reverseGeocode([31.23, 30.04]);
```

**Provider Selection:**
| Country | Priority |
|---------|----------|
| China | Baidu → HERE → OSM → Google |
| Russia/CIS | Yandex → HERE → OSM → Google |
| Egypt/Saudi | OSM → HERE → Google |
| US/UK | Google → HERE → OSM |
| Default | OSM → HERE → Google |

**Database Models Used:**

- ❌ None (API calls only)

---

### 8. safety/aiAnalyzer.js

**Layer 3: AI Contextual Analysis**

**Purpose:** Uses Gemini AI for deep contextual analysis when ML/Maps are uncertain.

**API Usage:**

```javascript
const aiAnalyzer = require('./services/safety/aiAnalyzer');

// Full context analysis
const result = await aiAnalyzer.analyzeContext({
  coordinates: [31.23, 30.04],
  role: 'tourist',
  mlAnalysis: {...},
  mapVerification: {...},
  tripDetails: {...},
  stoppedDuration: 300000
});
// Returns:
{
  status: 'analyzed',
  riskLevel: 'safe',
  confidence: 85,
  isJustified: true,
  justification: 'User is at a popular restaurant',
  shouldAskUser: false,
  shouldEscalate: false,
  recommendedActions: ['continue_monitoring']
}

// Analyze video thumbnails
const video = await aiAnalyzer.analyzeVideoThumbnail(
  ['https://i.ytimg.com/...'],
  { location: 'Cairo', videoTitle: 'Live protest' }
);
```

**Database Models Used:**

- ✅ `SafetyEvent` - Stores AI analysis results

---

### 9. safety/locationReputationService.js

**Layer 11: Location Reputation**

**Purpose:** Checks location safety from web searches, reviews, and video analysis.

**API Usage:**

```javascript
const reputationService = require('./services/safety/locationReputationService');

// Check location reputation
const rep = await reputationService.checkReputation([31.23, 30.04], tripDetails);
// Returns:
{
  locationName: 'Al-Azhar Park',
  riskScore: 25,
  riskLevel: 'safe',
  shouldAlert: false,
  dangerHits: [],
  reviewAnalysis: { ... },
  sources: ['tripadvisor', 'google'],
  dataAgeDays: 5
}

// Find safe alternatives if current location is risky
const alternatives = await reputationService.findSafeAlternatives(
  [31.23, 30.04],
  'EG'
);
```

**Data Freshness:**

- Place reputation: 30 days
- General area safety: 1 year
- High-risk areas: 3 months

**Database Models Used:**

- ✅ `LocationReputation` - Cached reputation data

---

### 10. safety/decisionOrchestrationService.js

**Layer 15: Decision Playbooks**

**Purpose:** Converts aggregated risk data into structured, actionable decisions.

**Playbooks:**
| Playbook | Action | Interrupt User? |
|----------|--------|-----------------|
| CRITICAL_ADVISORY | Emergency warning | ✅ Yes |
| REROUTE | Suggest alternative | ✅ Yes |
| DELAY | Recommend wait | ✅ Yes |
| MONITOR_INTENSE | Stealth tracking | ❌ No |
| PROCEED | Normal tracking | ❌ No |

**API Usage:**

```javascript
const decision = await decisionOrchestrationService.orchestrateDecision({
  mlResult: { riskScore: 0.85, riskLevel: 'dangerous' },
  temporalRisk: { legalStatus: 'compliant', riskScore: 0.2 },
  spatialRisk: { riskLevel: 'high', riskScore: 0.7 },
  aiVerdict: { riskScore: 0.8 }
}, tripId, tripDetails);

// Returns:
{
  playbook: 'CRITICAL_ADVISORY',
  reasoning: ['Multiple critical risk factors detected'],
  riskScore: 0.73,
  actionsTaken: ['Audit_Logged', 'User_Advisory_Sent', 'Admin_Notified']
}
```

> ⚠️ **Important:** This system is **ADVISORY ONLY**. It cannot stop or cancel trips.

---

## 🤖 ML Learning System

### How the System Learns

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Trip       │     │   ML Brain   │     │   Outcome    │
│   Events     │────▶│   Prediction │────▶│   Feedback   │
└──────────────┘     └──────────────┘     └──────────────┘
                            │                     │
                            │                     │
                            ▼                     ▼
                    ┌──────────────────────────────┐
                    │     SafetyTrainingData       │
                    │   (Raw data + Labels)        │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │      Python ML Brain         │
                    │   Daily Training Pipeline    │
                    └──────────────────────────────┘
```

### Learning Flow:

1. **Event Occurs:** Location update triggers safety analysis
2. **Prediction Made:** ML Brain predicts risk level
3. **Data Collected:** `dataCollector.js` stores event in `SafetyEvent`
4. **Trip Ends:** User provides feedback via `tripFeedbackService.js`
5. **Labels Updated:** Feedback outcome is stored as training label
6. **Daily Training:** Python ML Brain trains on new labeled data
7. **Weights Updated:** Neural network weights saved and refreshed

### Is the System Intelligent?

**Yes, the system implements several intelligence mechanisms:**

1. **Adaptive Trust Scoring:** Users with good history get less intrusive monitoring
2. **Personalized Thresholds:** AI analysis thresholds adjust based on user preference
3. **Online Learning:** System learns from each trip outcome
4. **Maturity Gating:** ML becomes more autonomous as accuracy improves
5. **Motion Trajectory Prediction:** Predicts user's destination and tolerates logical deviations

---

## 🗄️ Database Models (from `/models/`)

| Model                     | Purpose                    | Used By Services          |
| ------------------------- | -------------------------- | ------------------------- |
| `Order`                   | Trip/booking data          | Multiple                  |
| `User`                    | User accounts, FCM tokens  | Multiple                  |
| `SafetyEvent`             | Safety events for ML       | mlAnalyzer, aiAnalyzer    |
| `SafetyOutcome`           | Ground truth verification  | dataCollector             |
| `SafetyTrainingData`      | ML training data           | Python ML Brain           |
| `LocationReputation`      | Cached location reputation | locationReputationService |
| `TripFeedback`            | Post-trip feedback         | tripFeedbackService       |
| `TripNotificationHistory` | Notification log           | notificationQueueService  |
| `EmergencyAlert`          | Emergency alerts           | Not actively used         |
| `Chat`                    | Chat messages              | Not used in safety        |
| `Review`                  | User reviews               | Not used in safety        |
| `Audit`                   | Audit logs                 | Not used in safety        |

---

## 🔌 API Endpoints (via Controllers)

The services are exposed through controllers. Main endpoints:

```
POST /api/trips/:tripId/location
  → safetyOrchestrator.processLocationUpdate()

POST /api/trips/:tripId/response
  → safetyOrchestrator.processUserResponse()

POST /api/trips/:tripId/feedback
  → tripFeedbackService.submitFeedback()

GET /api/ml/status
  → mlBrain.getStats()

GET /api/ml/maturity
  → mlBrain.getMaturityStatus()
```

---

## 🏃 Quick Start for Developers

```javascript
// 1. Initialize ML Brain
const mlBrain = require("./services/mlBrain");
await mlBrain.init();

// 2. Process location update
const orchestrator = require("./services/safetyOrchestrator");
const result = await orchestrator.processLocationUpdate(
  tripId,
  "tourist",
  [31.235, 30.044],
  tripDetails,
);

// 3. Check user trust
const feedback = require("./services/tripFeedbackService");
const trust = await feedback.getUserTrustScore(userId);

// 4. Queue notification
const notif = require("./services/notificationQueueService");
await notif.queueNotification({
  userId,
  title: "Alert",
  body: "Message",
  priority: "HIGH",
});
```

---

## 🔧 Environment Variables

| Variable              | Purpose              | Default                |
| --------------------- | -------------------- | ---------------------- |
| `ML_BRAIN_URL`        | Python ML Brain URL  | `http://ml-brain:8000` |
| `ML_BRAIN_TIMEOUT`    | HTTP timeout (ms)    | `5000`                 |
| `GOOGLE_MAPS_API_KEY` | Google Maps API      | Required               |
| `GEMINI_API_KEY`      | Gemini AI API        | Required               |
| `BAIDU_MAPS_API_KEY`  | Baidu Maps (China)   | Optional               |
| `YANDEX_MAPS_API_KEY` | Yandex Maps (Russia) | Optional               |
| `HERE_API_KEY`        | HERE Maps backup     | Optional               |
