# Admin & System API Documentation

These endpoints are used for system optimization, limit management, and internal performance monitoring.

## Admin Dashboard APIs
Base URL: `/admin`

### 1. System Status & Limits
- **`GET /status`**: Current system health and efficiency metrics.
- **`POST /limits`**: Dynamically update batch sizes and API daily quotas.
- **`POST /reset-daily-limits`**: Reset usage counters.

### 2. User & Payment Management
- **`POST /set-premium-user`**: Manually upgrade a user to Premium.
- **`POST /revoke-premium`**: Revoke Premium status.
- **`POST /payment`**: Record a manual payment log.

### 3. Efficiency Reports
- **`GET /cost-report`**: Daily breakdown of API costs and savings.
- **`GET /quotas`**: Percentage usage of Google Maps and Gemini limits.

---

## System Internal APIs
Base URL: `/api/system`

### 4. Metrics & Performance
- **`GET /metrics`**: Prometheus-formatted metrics.
- **`GET /eventbus/metrics`**: Internal messaging performance.
- **`GET /scheduler/status`**: Current trip scheduling queue.

### 5. Safety Configuration
- **`GET /safety/config`**: Current thresholds for speed, deviation, and risk.
- **`DELETE /safety/curfew/:countryCode`**: Remove regional time restrictions.
- **`POST /reputation/check`**: Manual risk check for a specific coordinate.

### 6. Notification Management
- **`GET /notifications/stats`**: Queue length and throughput.
- **`POST /notifications/quiet-hours`**: Configure quiet time for specific users.
- **`DELETE /notifications/queue`**: Purge the notification queue.
