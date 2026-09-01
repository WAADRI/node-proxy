// =============================================================================
// CircuitBreaker - Auto-isolates failing clients
// =============================================================================
'use strict';

const STATE = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 };

class CircuitBreaker {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    // clientId -> { state, failures, lastFailure, halfOpenAttempts, openedAt }
    this.states = new Map();
    this._defaults = {
      error_threshold: config.circuit_breaker?.error_threshold || 5,
      window_ms: config.circuit_breaker?.window_ms || 60000,
      recovery_timeout_ms: config.circuit_breaker?.recovery_timeout_ms || 30000,
      half_open_max_attempts: config.circuit_breaker?.half_open_max_attempts || 3,
    };
  }

  _get(clientId) {
    if (!this.states.has(clientId)) {
      this.states.set(clientId, {
        state: STATE.CLOSED,
        failures: 0,
        lastFailure: 0,
        successes: 0,
        halfOpenAttempts: 0,
        openedAt: 0,
        windowStart: Date.now(),
      });
    }
    return this.states.get(clientId);
  }

  // Called when a request succeeds
  onSuccess(clientId) {
    const cb = this._get(clientId);
    if (cb.state === STATE.HALF_OPEN) {
      cb.successes++;
      if (cb.successes >= cb.halfOpenAttempts) {
        // Recovered
        this.log.info({ clientId }, 'Circuit breaker: client recovered');
        cb.state = STATE.CLOSED;
        cb.failures = 0;
        cb.successes = 0;
        cb.halfOpenAttempts = 0;
      }
    } else if (cb.state === STATE.CLOSED) {
      // Reset failure count on success (sliding window)
      cb.failures = 0;
      cb.windowStart = Date.now();
    }
  }

  // Called when a request fails (timeout, error, etc.)
  onFailure(clientId) {
    const cb = this._get(clientId);
    const now = Date.now();

    if (cb.state === STATE.CLOSED) {
      // Check if window has expired; if so, reset
      if (now - cb.windowStart > this._defaults.window_ms) {
        cb.failures = 0;
        cb.windowStart = now;
      }

      cb.failures++;
      cb.lastFailure = now;

      if (cb.failures >= this._defaults.error_threshold) {
        this.log.warn({
          clientId,
          failures: cb.failures,
          window: this._defaults.window_ms,
        }, 'Circuit breaker: client OPENED');
        cb.state = STATE.OPEN;
        cb.openedAt = now;
      }
    } else if (cb.state === STATE.HALF_OPEN) {
      // Failed during half-open test, back to OPEN
      this.log.warn({ clientId }, 'Circuit breaker: half-open test failed, back to OPEN');
      cb.state = STATE.OPEN;
      cb.openedAt = now;
      cb.successes = 0;
    }
  }

  // Check if a client is allowed to receive requests
  isAllowed(clientId) {
    const cb = this._get(clientId);
    const now = Date.now();

    if (cb.state === STATE.CLOSED) return true;

    if (cb.state === STATE.OPEN) {
      // Check if recovery timeout has elapsed
      if (now - cb.openedAt > this._defaults.recovery_timeout_ms) {
        // Transition to HALF_OPEN - allow a test request
        this.log.info({ clientId }, 'Circuit breaker: HALF_OPEN (testing)');
        cb.state = STATE.HALF_OPEN;
        cb.halfOpenAttempts++;
        cb.successes = 0;
        return true;
      }
      return false;
    }

    // HALF_OPEN - allow requests (but they'll be tracked)
    if (cb.state === STATE.HALF_OPEN) {
      return true;
    }

    return true;
  }

  getState(clientId) {
    const cb = this.states.get(clientId);
    if (!cb) return 'closed';
    const stateNames = ['closed', 'open', 'half_open'];
    return stateNames[cb.state] || 'unknown';
  }

  getStatus(clientId) {
    const cb = this.states.get(clientId);
    if (!cb) return { state: 'closed', failures: 0 };
    const stateNames = ['closed', 'open', 'half_open'];
    return {
      state: stateNames[cb.state],
      failures: cb.failures,
      lastFailure: cb.lastFailure,
      openedAt: cb.openedAt,
      halfOpenAttempts: cb.halfOpenAttempts,
    };
  }

  getAllStatuses() {
    const result = {};
    for (const [id] of this.states) {
      result[id] = this.getStatus(id);
    }
    return result;
  }

  // Manually reset a client's circuit breaker
  reset(clientId) {
    this.states.delete(clientId);
    this.log.info({ clientId }, 'Circuit breaker: manually reset');
  }

  // Cleanup stale entries
  cleanup(activeClientIds) {
    const activeSet = new Set(activeClientIds);
    for (const [id] of this.states) {
      if (!activeSet.has(id)) {
        this.states.delete(id);
      }
    }
  }
}

module.exports = { CircuitBreaker, STATE };