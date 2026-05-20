/**
 * Trip Event Emitter
 */

const EventEmitter = require("events");

class TripEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  emitLocationUpdate(tripId, role, coordinates) {
    this.emit("location_update", {
      tripId,
      role,
      coordinates,
      timestamp: Date.now(),
    });
  }

  emitSafetyAlert(tripId, alertType, details) {
    this.emit("safety_alert", {
      tripId,
      alertType,
      details,
      timestamp: Date.now(),
    });
  }

  emitMeetingConfirmed(tripId) {
    this.emit("meeting_confirmed", { tripId, timestamp: Date.now() });
  }

  emitDistanceWarning(tripId, distance, level) {
    this.emit("distance_warning", {
      tripId,
      distance,
      level,
      timestamp: Date.now(),
    });
  }

  emitTripStatusChange(tripId, status) {
    this.emit("trip_status_change", { tripId, status, timestamp: Date.now() });
  }

  emitLocationVisited(tripId, locationName, visitedCount, totalCount) {
    this.emit("location_visited", {
      tripId,
      locationName,
      visitedCount,
      totalCount,
      timestamp: Date.now(),
    });
  }

  emitRouteDeviation(tripId, deviationType) {
    this.emit("route_deviation", {
      tripId,
      deviationType,
      timestamp: Date.now(),
    });
  }

  emitSpeedWarning(tripId, speed, vehicleType) {
    this.emit("speed_warning", {
      tripId,
      speed,
      vehicleType,
      timestamp: Date.now(),
    });
  }
}

module.exports = new TripEventEmitter();
