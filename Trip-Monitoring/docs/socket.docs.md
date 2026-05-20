# Socket.IO Event Documentation

The Trip-Monitoring service uses Socket.IO for real-time bi-directional communication between the server and clients (Tourists, Guides, and Admins).

## Connection & Auth
- **URL**: `ws://<server-url>/`
- **Auth**: Sent via headers/middleware (JWT).
- **Rooms**: Users are automatically tracked in `userSocketMap`.

---

## Server -> Client (Emitted Events)

### 1. General & Connection
- **`connected`**: Confirms successful connection.
  - Payload: `{ userId: string, socketId: string }`
- **`onlineUsers`**: List of all currently active UIDs.
  - Payload: `string[]`

### 2. Trip & Location
- **`location_update`**: Real-time position of the other party.
  - Payload: `{ tripId, coordinates: [lng, lat], role: 'guide|normal' }`
- **`location_visited`**: Triggered when a POI is reached.
  - Payload: `{ tripId, locationId, name }`
- **`partner_arrived`**: Notifies that the other party reached the meeting point.
  - Payload: `{ tripId, role, message }`

### 3. Safety Alerts
- **`safety_alert`**: Generic safety notification.
- **`distance_warning`**: Triggered when guide and tourist are too far apart.
  - Payload: `{ tripId, distance, message }`
- **`speed_warning`**: Triggered by excessive or abnormal speed.
  - Payload: `{ tripId, speed, limit, message }`
- **`route_deviation_question`**: Asks the tourist if a deviation was intentional.
  - Payload: `{ tripId, questionId, text, options }`
- **`tourist_deviation_alert`**: Notifies guide that tourist deviated.
- **`urgent_safety_check`**: Direct manual or automated check-in.
  - Payload: `{ tripId, message }`
- **`emergency_alert`**: Escalated safety event.
- **`reputation_warning`**: Warns about entering a low-reputation/risky area.

### 4. System & Health
- **`device_health_warning`**: Low battery or poor signal alert from partner.
- **`device_health_prediction`**: Notification about likely device failure.
- **`wrong_meeting_location`**: Prompt for being at the wrong assembly point.

### 5. Management
- **`completion_requested`**: Completion request from the other party.
- **`trip_completed`**: Final confirmation of trip end.
- **`trip_cancelled`**: Notification of cancellation.
- **`trip_cancelled_noshow`**: Cancellation due to no-show at meeting point.

---

## Client -> Server (Received Events)

- **`register_admin`**: Registers the current socket as an admin listener.
- **`typing`**: Simple activity indicator.
- **`joinRoom`**: Join a specific trip room (if applicable).
