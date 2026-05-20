# Trip Monitoring REST API Documentation

Base URL: `/api/trip-monitoring`

## Endpoints

### 1. Update Location
- **URL**: `/location`
- **Method**: `POST`
- **Access**: Private (Tourist/Guide)
- **Description**: Submits current coordinates and triggers safety checks.

**Request Body**:
```json
{
  "tripId": "string",
  "coordinates": [lng, lat],
  "accuracy": "number",
  "timestamp": "number (ms)"
}
```

---

### 2. Respond to Safety Check
- **URL**: `/safety-response`
- **Method**: `POST`
- **Access**: Private
- **Description**: Confirms safety after an automated check-in prompt.

**Request Body**:
```json
{
  "tripId": "string",
  "response": "ok | help | object"
}
```

---

### 3. Update Device Health
- **URL**: `/device-health`
- **Method**: `POST`
- **Access**: Private
- **Description**: Reports battery level and network quality.

**Request Body**:
```json
{
  "tripId": "string",
  "battery": 0-100,
  "signalStrength": 0-4,
  "networkType": "wifi | 4g | 5g",
  "isCharging": "boolean"
}
```

---

### 4. Respond to Route Deviation
- **URL**: `/route-response`
- **Method**: `POST`
- **Access**: Private (Tourist)
- **Description**: Confirms if a route change was intentional.

---

### 5. Check Arrival at Meeting Point
- **URL**: `/check-meeting-point`
- **Method**: `POST`
- **Access**: Private (Tourist/Guide)
- **Description**: Verifies if the user has reached the defined start location.

---

### 6. Request Completion
- **URL**: `/request-completion`
- **Method**: `POST`
- **Access**: Private
- **Description**: Signals that the trip has concluded. Requires confirmation from both parties.

---

### 7. Trip Cancellation
- **URL**: `/cancel`
- **Method**: `POST`
- **Access**: Private
- **Description**: Cancels the trip before or during execution. May apply fees if "in_progress".

---

### 8. Trip Status & Progress
- **Status**: `GET /:tripId/status` -> Detailed coordinates + escalation level.
- **Progress**: `GET /:tripId/progress` -> POI visit stats.
- **Payment**: `GET /:tripId/payment-summary` -> Final cost breakdown.
- **Feedback**: `POST /:tripId/feedback` -> Post-trip rating and comment.
