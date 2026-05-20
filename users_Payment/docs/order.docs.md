# Order API Documentation

Base URL: `/api/order`

## Tourist Endpoints

### 1. Create Order (Standard)
- **URL**: `/create`
- **Method**: `POST`
- **Access**: Private (Tourist)
- **Description**: Creates a new trip order.

**Request Body**:
```json
{
  "title": "string",
  "description": "string",
  "TripDate": "ISODate",
  "duration": "number",
  "price": "number",
  "destinationCountry": "string",
  "serviceType": "with_guide | solo_system",
  "destinationStatus": "defined | undefined",
  "locations": [{ "lat": "number", "lng": "number" }],
  "meetingPoint": { "lat": "number", "lng": "number" },
  "safetyConfig": { "plan": "free | premium" },
  "isSolo": "boolean",
  "companionsCount": "number"
}
```

---

### 2. Create Order With Specific Guide
- **URL**: `/createWithGuide`
- **Method**: `POST`
- **Access**: Private (Tourist)
- **Description**: Creates an order and assigns it to a specific guide immediately.

**Request Body**:
```json
{
  "guideId": "string",
  "title": "string",
  "description": "string",
  "TripDate": "ISODate",
  "duration": "number",
  "price": "number",
  "location": { "lat": "number", "lng": "number" },
  "meetingPoint": { "lat": "number", "lng": "number" }
}
```

---

### 3. Get Nearby Guides
- **URL**: `/getNearbyGuides`
- **Method**: `GET`
- **Access**: Private (Tourist)
- **Description**: Searches for guides near the user's location who speak their language.

---

### 4. Review Applicants
- **URL**: `/reviewApplicants`
- **Method**: `POST`
- **Access**: Private (Tourist)
- **Description**: Retrieves a list of guides who expressed interest or submitted offers for an order.

**Query Params**:
- `sortBy`: `lowest_price | most_experienced | immediate_acceptance | random`

---

## Guide Endpoints

### 5. Get Available Orders
- **URL**: `/getOrdersForGuide`
- **Method**: `GET`
- **Access**: Private (Guide)
- **Description**: Lists open orders in the guide's vicinity that match their language.

---

### 6. Accept/Bid on Order
- **URL**: `/acceptOrder`
- **Method**: `POST`
- **Access**: Private (Guide)
- **Description**: Used to express interest in an open order or submit a custom price/itinerary.

**Request Body**:
```json
{
  "proposedPrice": "number (optional)",
  "proposedItinerary": "[{lat, lng}] (optional)",
  "description": "string (optional)"
}
```

---

### 7. Confirm Trip Start
- **URL**: `/confirmOrder`
- **Method**: `POST`
- **Access**: Private (Guide)
- **Description**: Confirms the guide is at the meeting point and ready to start.
---

### 8. Reject Assigned Order
- **URL**: `/rejectOrder`
- **Method**: `POST`
- **Access**: Private (Guide)
- **Description**: Rejects an order specifically assigned to this guide.
