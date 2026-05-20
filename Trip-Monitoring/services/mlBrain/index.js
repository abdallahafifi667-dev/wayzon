/**
 * ML Brain Client - Bridge to Python ML Service
 * Maintains the same API as the original mlBrain module for backward compatibility
 *
 * This module acts as an HTTP client that communicates with the Python FastAPI service
 * running on port 8001 (internal: 8000)
 */

const config = require("./config");
const { mlBrainHttpClient: client, ML_BRAIN_URL } = require("./httpClient");
const { logger } = require("../../monitoring/metrics");
const userProfileService = require("../safety/userProfileService");

class MLBrainClient {
  constructor() {
    this.isInitialized = false;
    this.config = config; // Export config for backward compatibility
    this._fallbackMode = false;
    this._lastHealthCheck = 0;
    this._healthCheckInterval = 30000; // 30 seconds
    this._consecutiveFailures = 0; // ✅ Track failure rate
    this._maxConsecutiveFailures = 5;
  }

  /**
   * Initialize the ML Brain connection
   * Checks health of Python service
   */
  async init() {
    if (this.isInitialized) return true;

    const maxWarmupAttempts = 15;

    for (let attempt = 0; attempt < maxWarmupAttempts; attempt++) {
      try {
        const response = await client.get("/health", { timeout: 3000 });

        if (response.data?.status === "healthy" && response.data?.initialized) {
          this.isInitialized = true;
          this._fallbackMode = false;
          this._consecutiveFailures = 0;

          logger.info("ML Brain Python service connected successfully", {
            version: response.data.version,
            timestamp: new Date().toISOString(),
          });
          return true;
        }

        logger.warn("ML Brain health: waiting for full initialization", {
          attempt: attempt + 1,
          initialized: response.data?.initialized,
        });
      } catch (err) {
        this._consecutiveFailures++;

        if (this._consecutiveFailures >= this._maxConsecutiveFailures) {
          logger.error("CRITICAL: ML Brain service unavailable after multiple attempts", {
            consecutiveFailures: this._consecutiveFailures,
            error: err.message,
            code: err.code,
            baseURL: ML_BRAIN_URL,
            timestamp: new Date().toISOString(),
          });
        } else {
          logger.warn("ML Brain connection attempt failed", {
            attempt: this._consecutiveFailures,
            error: err.message,
          });
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    this._fallbackMode = true;
    this.isInitialized = true;
    logger.error("ML Brain: stopped warmup after max attempts", {
      maxWarmupAttempts,
      baseURL: ML_BRAIN_URL,
    });
    return false;
  }

  /**
   * Validate coordinates before sending to ML
   * @throws {Error} if coordinates are invalid
   */
  _validateCoordinates(coordinates) {
    let longitude, latitude;

    if (Array.isArray(coordinates)) {
      [longitude, latitude] = coordinates;
    } else if (coordinates?.longitude !== undefined) {
      longitude = coordinates.longitude;
      latitude = coordinates.latitude;
    } else if (coordinates?.lng !== undefined) {
      longitude = coordinates.lng;
      latitude = coordinates.lat;
    } else {
      // ✅ FAIL LOUD - Don't default to 0
      throw new Error(`Invalid coordinates format: ${JSON.stringify(coordinates)}`);
    }

    // ✅ Validate range
    if (typeof longitude !== 'number' || typeof latitude !== 'number') {
      throw new Error(`Coordinates must be numbers: lng=${longitude}, lat=${latitude}`);
    }

    if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
      throw new Error(`Coordinates out of range: lng=${longitude}, lat=${latitude}`);
    }

    // ✅ Reject null island (0, 0) - likely invalid data
    if (longitude === 0 && latitude === 0) {
      throw new Error("Coordinates cannot be (0, 0) - likely invalid data");
    }

    return { longitude, latitude };
  }

  /**
   * Get safety proposal from ML Brain
   * Main entry point for safety analysis
   *
   * @param {Object} event - Safety event with coordinates, speed, etc.
   * @param {Object} tripDetails - Trip context
   * @returns {Object} Decision with risk level, actions, and confidence
   */
  async getSafetyProposal(event, tripDetails) {
    if (!this.isInitialized) await this.init();

    // ✅ Check if we should try reconnecting
    if (
      this._fallbackMode &&
      Date.now() - this._lastHealthCheck > this._healthCheckInterval
    ) {
      this._lastHealthCheck = Date.now();
      try {
        await client.get("/health", { timeout: 2000 });
        this._fallbackMode = false;
        this._consecutiveFailures = 0;
        logger.info("ML Brain service reconnected");
      } catch (err) {
        this._consecutiveFailures++;
        logger.warn("ML Brain reconnection attempt failed", {
          consecutiveFailures: this._consecutiveFailures,
          error: err.message,
          timestamp: new Date().toISOString()
        });
      }
    }

    // ✅ FAIL LOUD in fallback mode
    if (this._fallbackMode) {
      logger.warn("ML Brain in fallback mode - returning conservative decision", {
        tripId: tripDetails._id?.toString(),
        consecutiveFailures: this._consecutiveFailures
      });
      return this._getFallbackDecision("python_service_unavailable");
    }

    try {
      // ✅ Validate coordinates BEFORE sending
      const validatedCoords = this._validateCoordinates(event.coordinates || event);

      // ✅ Fetch user profiles with proper error handling
      let userProfiles = null;
      try {
        userProfiles = await userProfileService.getTripParticipantProfiles(tripDetails);
        logger.debug("User profiles loaded for ML", {
          touristTrust: userProfiles.tourist?.trustScore,
          guideTrust: userProfiles.guide?.trustScore,
          combinedRisk: userProfiles.combined?.overallRisk
        });
      } catch (err) {
        // ✅ FAIL LOUD - Don't silently ignore
        logger.error("Failed to load user profiles for ML", {
          tripId: tripDetails._id?.toString(),
          error: err.message,
          stack: err.stack
        });
        // Continue without profiles but log the failure
      }

      const payload = this._buildPredictPayload(
        { ...event, coordinates: validatedCoords },
        tripDetails,
        userProfiles
      );

      const response = await client.post("/api/v1/predict", payload);

      if (response.data.success && response.data.decision) {
        this._consecutiveFailures = 0; // ✅ Reset on success

        const decision = response.data.decision;

        // Map Tiered Intelligence response to Orchestrator
        return {
          action: decision.action || "PROCEED", // 🆕 Main control signal
          riskScore: decision.risk_score,
          riskLevel: decision.risk_level,
          mustUseMaps: decision.must_use_maps,
          mustUseAI: decision.must_use_ai,
          shouldEscalate: decision.should_escalate,
          confidence: decision.confidence,
          layerOverride: decision.layer_override,
          reasoning: decision.reasoning,
          suggestedLayers: decision.suggested_layers,
          // 🆕 Strategic Audit from the "Conscious" layer
          strategicConsultation: decision.strategic_consultation,
          executiveReasoning: decision.reasoning,
          modelVersion: decision.model_version,
          modelTrainedAt: decision.model_trained_at,
          userPersonalization: decision.user_personalization,
          decisionSource: decision.decision_source || "ml_brain_py",
          useLegacy: decision.decision === "fallback",
          processingTime: Date.now() - payload._startTime,
          profileBasedAdjustments: userProfiles
            ? {
              monitoringIntensity: userProfiles.combined?.suggestedIntensity,
              alertThreshold:
                userProfiles.tourist?.recommendations?.alertThreshold,
            }
            : null,
          userProfiles: userProfiles,
        };
      }

      // ✅ Invalid response - FAIL LOUD
      logger.error("ML Brain returned invalid response", {
        tripId: tripDetails._id?.toString(),
        response: response.data
      });
      return this._getFallbackDecision("invalid_response");

    } catch (err) {
      this._consecutiveFailures++;

      // ✅ FAIL LOUD with full context
      logger.error("ML Brain prediction failed", {
        tripId: tripDetails._id?.toString(),
        error: err.message,
        stack: err.stack,
        consecutiveFailures: this._consecutiveFailures,
        timestamp: new Date().toISOString()
      });

      this._fallbackMode = true;
      return this._getFallbackDecision("prediction_error", err.message);
    }
  }

  /**
   * Learn from an event outcome (online learning)
   *
   * @param {Object} event - Event data
   * @param {Object} tripDetails - Trip context
   */
  async learn(event, tripDetails) {
    if (this._fallbackMode) return;

    try {
      const payload = this._buildPredictPayload(event, tripDetails);
      await client.post("/api/v1/learn", payload);
      logger.debug("ML Brain learning event submitted");
    } catch (err) {
      logger.debug("ML Brain learning failed", { error: err.message });
    }
  }

  /**
   * Refresh model weights from disk
   * Called during maintenance cycle
   */
  async refreshWeights() {
    if (this._fallbackMode) return;

    try {
      const response = await client.post("/api/v1/model/refresh");
      if (response.data.success) {
        logger.info("ML Brain weights refreshed");
      }
    } catch (err) {
      logger.warn("ML Brain weight refresh failed", { error: err.message });
    }
  }

  /**
   * Get maturity status
   */
  async getMaturityStatus() {
    if (this._fallbackMode) {
      return { level: 0, name: "Unavailable", is_mature: false };
    }

    try {
      const response = await client.get("/api/v1/maturity");
      return response.data;
    } catch {
      return { level: 0, name: "Error", is_mature: false };
    }
  }

  /**
   * Check if ready for autonomous decisions
   */
  async isReadyForAutonomous() {
    if (this._fallbackMode) return false;

    try {
      const response = await client.get("/api/v1/maturity/ready");
      return response.data.ready;
    } catch {
      return false;
    }
  }

  /**
   * Get comprehensive system stats
   */
  async getStats() {
    if (this._fallbackMode) {
      return { status: "fallback_mode", initialized: false };
    }

    try {
      const response = await client.get("/api/v1/status");
      return response.data;
    } catch {
      return { status: "error" };
    }
  }

  /**
   * Build prediction payload with validated coordinates
   * @private
   */
  _buildPredictPayload(event, tripDetails, userProfiles = null) {
    // Coordinates already validated by caller
    const { longitude, latitude } = event.coordinates;

    return {
      event: {
        coordinates: { longitude, latitude },
        speed: event.speed || 0,
        timestamp: event.timestamp || new Date().toISOString(),
        device_health: event.deviceHealth || { battery: 100, signal: 4 },
        distance_from_guide: event.distanceFromGuide || 0,
        time_since_last_update: event.timeSinceLastUpdate || 20,
        weather: event.weather || "clear",
        risk_score: event.riskScore || 0.5,
        crowd_density: event.crowdDensity || 0.5,
        nearby_events_count: event.nearbyEventsCount || 0,
        route_complexity: event.routeComplexity || 0.5,
      },
      trip: {
        trip_id: tripDetails._id?.toString() || tripDetails.tripId || "unknown",
        service_type: tripDetails.serviceType || "guided",
        country: tripDetails.country || tripDetails.destinationCountry,
        country_name: tripDetails.countryName,
        actual_start_time: tripDetails.actualStartTime,
        planned_end_time: tripDetails.plannedEndTime || tripDetails.TripEndTime,
        expected_duration: tripDetails.expectedDuration || 0,
        user_response_rate: tripDetails.userResponseRate || 0.8,
        previous_incidents: tripDetails.previousIncidents || 0,
        behavior_score: tripDetails.behaviorScore || 0.5,
        guide_id: tripDetails.guide?.toString(),
        tourist_id: tripDetails.normal?.toString(),
        destination_country: tripDetails.destinationCountry,
      },
      extended_data: {
        guide_safety_score: tripDetails.guideSafetyScore || 5.0,
        guide_review_rating: tripDetails.guideReviewRating || 5.0,
        guide_success_rate: tripDetails.guideSuccessRate || 0.9,
        destination_popularity: tripDetails.destinationPopularity || 0.5,
        tourist_rating: tripDetails.touristRating || 5.0,
        avg_sentiment: tripDetails.avgSentiment || 0.5,
        prefers_fewer_messages: tripDetails.safetyConfig?.plan === "free",
        safety_plan: tripDetails.safetyConfig?.plan || "free",
      },
      // ✅ User profiles from EmergencyAlert, Chat, Review, TripFeedback
      user_profiles: userProfiles
        ? {
          tourist: userProfiles.tourist
            ? {
              trust_score: userProfiles.tourist.trustScore,
              risk_level: userProfiles.tourist.riskProfile?.level,
              risk_score: userProfiles.tourist.riskProfile?.score,
              risk_factors: userProfiles.tourist.riskProfile?.factors || [],
              emergency_history: {
                total_incidents:
                  userProfiles.tourist.emergencyHistory?.totalIncidents ||
                  0,
                has_unresolved:
                  userProfiles.tourist.emergencyHistory
                    ?.hasUnresolvedAlerts || false,
                most_common_type:
                  userProfiles.tourist.emergencyHistory?.mostCommonType,
              },
              communication: {
                style: userProfiles.tourist.communication?.style,
                uses_emergency_keywords:
                  userProfiles.tourist.communication?.usesEmergencyKeywords,
                preferred_language:
                  userProfiles.tourist.communication?.preferredLanguage,
              },
              ratings: {
                avg_given: userProfiles.tourist.ratings?.avgGiven,
                avg_received: userProfiles.tourist.ratings?.avgReceived,
                sentiment: userProfiles.tourist.ratings?.sentiment,
              },
              experience: {
                total_trips:
                  userProfiles.tourist.experience?.totalTrips || 0,
                incident_rate:
                  userProfiles.tourist.experience?.incidentRate || 0,
                completion_rate:
                  userProfiles.tourist.experience?.completionRate || 0,
              },
              ml_features: userProfiles.tourist.mlFeatures,
              monitoring_intensity:
                userProfiles.tourist.recommendations?.monitoringIntensity,
              alert_threshold:
                userProfiles.tourist.recommendations?.alertThreshold,
            }
            : null,
          guide: userProfiles.guide
            ? {
              trust_score: userProfiles.guide.trustScore,
              risk_level: userProfiles.guide.riskProfile?.level,
              risk_score: userProfiles.guide.riskProfile?.score,
              emergency_history: {
                total_incidents:
                  userProfiles.guide.emergencyHistory?.totalIncidents || 0,
              },
              ratings: {
                avg_received: userProfiles.guide.ratings?.avgReceived,
                sentiment: userProfiles.guide.ratings?.sentiment,
              },
              experience: {
                total_trips: userProfiles.guide.experience?.totalTrips || 0,
                completion_rate:
                  userProfiles.guide.experience?.completionRate || 0,
              },
              ml_features: userProfiles.guide.mlFeatures,
            }
            : null,
          combined_risk: userProfiles.combined?.overallRisk,
          suggested_intensity: userProfiles.combined?.suggestedIntensity,
        }
        : null,
      _startTime: Date.now(),
    };
  }

  /**
   * Generate fallback decision when Python service is unavailable
   * @private
   */
  _getFallbackDecision(reason, details = "") {
    // ✅ Log fallback usage for monitoring
    logger.warn("Using ML Brain fallback decision", {
      reason,
      details,
      timestamp: new Date().toISOString()
    });

    return {
      decision: "fallback",
      useLegacy: true,
      reasoning: `Fallback activated: ${reason}${details ? ` - ${details}` : ""}`,
      riskLevel: "unknown",
      riskScore: 0.5,
      confidence: 0.0,
      mustUseMaps: true,
      mustUseAI: true,
      shouldEscalate: false,
      decisionSource: "legacy_system",
      processingTime: 0,
    };
  }
}

// Singleton instance
module.exports = new MLBrainClient();

