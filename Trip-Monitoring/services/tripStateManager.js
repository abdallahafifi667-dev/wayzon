/**
 * Trip State Manager - إدارة حالة الرحلات النشطة في Redis
 * يتتبع المواقع والحالات والمسافات للرحلات الجارية
 */

const { client: redis, connectRedis } = require("../config/redis");
const { logger } = require("../monitoring/metrics");

const TRIP_STATE_PREFIX = "trip:state:";
const TRIP_LOCATION_PREFIX = "trip:location:";
const TRIP_TTL = 60 * 60 * 24; // 24 hours

class TripStateManager {
  async ensureConnection() {
    if (!redis.isOpen) {
      await connectRedis();
    }
  }

  async setTripState(tripId, state) {
    await this.ensureConnection();
    const key = `${TRIP_STATE_PREFIX}${tripId}`;
    await redis.setEx(
      key,
      TRIP_TTL,
      JSON.stringify({
        ...state,
        updatedAt: Date.now(),
      }),
    );
  }

  async getTripState(tripId) {
    await this.ensureConnection();
    const key = `${TRIP_STATE_PREFIX}${tripId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * 🆕 Get or create trip state - used by safetyOrchestrator
   * Creates initial state if it doesn't exist
   */
  async getOrCreateTripState(tripId) {
    let state = await this.getTripState(tripId);
    if (!state) {
      state = {
        createdAt: Date.now(),
        hasMet: false,
        escalationLevel: 0,
      };
      await this.setTripState(tripId, state);
    }
    return state;
  }

  /**
   * 🆕 Partial update of trip state - merges with existing
   */
  async updateTripState(tripId, updates) {
    const state = (await this.getTripState(tripId)) || {};
    Object.assign(state, updates);
    await this.setTripState(tripId, state);
    return state;
  }

  async updateLocation(tripId, role, coordinates, timestamp = Date.now()) {
    await this.ensureConnection();
    const locationKey = `${TRIP_LOCATION_PREFIX}${tripId}:${role}`;
    const stateKey = `${TRIP_STATE_PREFIX}${tripId}`;
    const location = {
      coordinates,
      timestamp,
      updatedAt: Date.now(),
    };

    // Use Redis WATCH for optimistic locking to prevent race conditions
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Watch the state key for changes
        await redis.watch(stateKey);

        // Get current state
        const currentData = await redis.get(stateKey);
        const state = currentData ? JSON.parse(currentData) : {};

        // Modify state based on role
        if (role === "guide") {
          state.lastGuideLocation = coordinates;
          state.lastGuideUpdate = timestamp;
        } else {
          state.lastTouristLocation = coordinates;
          state.lastTouristUpdate = timestamp;
        }
        state.lastLocationUpdate = timestamp;
        state.updatedAt = Date.now();

        // Execute atomically
        const multi = redis.multi();
        multi.setEx(locationKey, TRIP_TTL, JSON.stringify(location));
        multi.setEx(stateKey, TRIP_TTL, JSON.stringify(state));

        const results = await multi.exec();

        // If results is null, the watched key was modified - retry
        if (results === null) {
          logger.debug("Race condition detected in updateLocation, retrying", {
            tripId,
            role,
            attempt: attempt + 1,
          });
          continue;
        }

        return location;
      } catch (err) {
        await redis.unwatch();
        if (attempt === maxRetries - 1) {
          logger.error("updateLocation failed after retries", {
            tripId,
            role,
            error: err.message,
          });
          throw err;
        }
      }
    }

    // Fallback if all retries failed
    logger.warn("updateLocation falling back to non-atomic update", {
      tripId,
      role,
    });
    await redis.setEx(locationKey, TRIP_TTL, JSON.stringify(location));
    const state = (await this.getTripState(tripId)) || {};
    if (role === "guide") {
      state.lastGuideLocation = coordinates;
      state.lastGuideUpdate = timestamp;
    } else {
      state.lastTouristLocation = coordinates;
      state.lastTouristUpdate = timestamp;
    }
    state.lastLocationUpdate = timestamp;
    await this.setTripState(tripId, state);
    return location;
  }

  async getLocations(tripId) {
    await this.ensureConnection();
    const [guideData, touristData] = await Promise.all([
      redis.get(`${TRIP_LOCATION_PREFIX}${tripId}:guide`),
      redis.get(`${TRIP_LOCATION_PREFIX}${tripId}:normal`),
    ]);

    return {
      guide: guideData ? JSON.parse(guideData) : null,
      tourist: touristData ? JSON.parse(touristData) : null,
    };
  }

  calculateDistance(coord1, coord2) {
    if (!coord1 || !coord2) return null;
    const [lon1, lat1] = coord1;
    const [lon2, lat2] = coord2;
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  async getDistance(tripId) {
    const locations = await this.getLocations(tripId);
    if (!locations.guide || !locations.tourist) return null;
    return this.calculateDistance(
      locations.guide.coordinates,
      locations.tourist.coordinates,
    );
  }

  async setMeetingStatus(tripId, hasMet) {
    const state = (await this.getTripState(tripId)) || {};
    state.hasMet = hasMet;
    state.metAt = hasMet ? Date.now() : null;
    await this.setTripState(tripId, state);
  }

  async setEscalationLevel(tripId, level) {
    const state = (await this.getTripState(tripId)) || {};
    state.escalationLevel = level;
    state.lastEscalation = Date.now();
    await this.setTripState(tripId, state);
  }

  async setPendingResponse(tripId, questionType, sentTo, extraData = {}) {
    const state = (await this.getTripState(tripId)) || {};
    state.pendingResponse = {
      type: questionType,
      sentTo,
      sentAt: Date.now(),
      ...extraData, // Support questionId, fullQuestion, etc.
    };
    await this.setTripState(tripId, state);
  }

  async clearPendingResponse(tripId) {
    const state = (await this.getTripState(tripId)) || {};
    state.pendingResponse = null;
    await this.setTripState(tripId, state);
  }

  async clearTripState(tripId) {
    await this.ensureConnection();
    await Promise.all([
      redis.del(`${TRIP_STATE_PREFIX}${tripId}`),
      redis.del(`${TRIP_LOCATION_PREFIX}${tripId}:guide`),
      redis.del(`${TRIP_LOCATION_PREFIX}${tripId}:normal`),
    ]);
  }
}

module.exports = new TripStateManager();
