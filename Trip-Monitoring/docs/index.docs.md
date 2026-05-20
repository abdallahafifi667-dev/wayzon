# Trip-Monitoring Service - API Documentation

Welcome to the documentation for the **Trip-Monitoring** service. This service handles real-time tracking, safety monitoring, and automated alerts during trips.

## Service Overview
The service is highly event-driven, utilizing **Socket.IO** for real-time updates and a set of **REST APIs** for state transitions and health reporting.

## Documentation Modules

### ⚡ [Socket.IO Events](file:///e:/javascript/wayzon/backEnd/Trip-Monitoring/docs/socket.docs.md)
Detailed mapping of all real-time events, including location updates, safety alerts, and system notifications.

### 🛰️ [Monitoring APIs](file:///e:/javascript/wayzon/backEnd/Trip-Monitoring/docs/monitoring.docs.md)
REST endpoints for updating locations, responding to safety checks, and managing trip progression.

### 🛠️ [Admin & System APIs](file:///e:/javascript/wayzon/backEnd/Trip-Monitoring/docs/admin.docs.md)
Management tools for system limits, cost optimization, metrics, and global safety configurations.

---

## Technical Details
- **Real-time Protocol**: Socket.IO with JWT authentication.
- **REST Base URL**: `/api/trip-monitoring` (User) and `/admin` (Admin).
- **Security**: Requires a valid `x-auth-token` and `x-admin-key` for admin routes.
