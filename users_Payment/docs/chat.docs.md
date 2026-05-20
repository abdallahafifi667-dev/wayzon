# Chat & Socket.IO Documentation

Base URL: `/api/chat`

## REST APIs

### 1. Send Message
- **URL**: `/send`
- **Method**: `POST`
- **Access**: Private
- **Description**: Sends a message to another user. Requires an active order between them.

**Request Body**:
```json
{
  "to": "string (userId)",
  "message": "string",
  "orderId": "string"
}
```

---

### 2. Get Messages
- **URL**: `/messages/:userId`
- **Method**: `GET`
- **Access**: Private
- **Description**: Retrieves message history between the current user and target user.

---

### 3. Get RTC Config
- **URL**: `/rtc/config`
- **Method**: `GET`
- **Access**: Private
- **Description**: Returns WebRTC (TURN/STUN) servers for video calls.

---

### 4. Call Management
- **Start Call**: `POST /call/start` { to: userId, peerId: string }
- **Accept Call**: `POST /call/accept` { from: userId, offer: object, peerId: string }
- **Reject Call**: `POST /call/reject` { from: userId, reason: string }
- **End Call**: `POST /call/end` { to: userId }

---

## Socket.IO Events

### Client -> Server
- `joinRoom`: Joins a room based on userId or orderId.
- `typing`: Notifies the recipient that the user is typing.

### Server -> Client (Events Emitted)
- **`newMessage`**: Triggered when a message is sent.
- **`incomingCall`**: Triggered when a user starts a call.
- **`callAccepted`**: Triggered when the recipient accepts.
- **`callRejected`**: Triggered when the recipient rejects.
- **`callEnded`**: Triggered when either party ends the call.

**Payload Format (General)**:
```json
{
  "from": "userId",
  "message": "string",
  "timestamp": "ISO8601",
  "orderId": "string"
}
```
