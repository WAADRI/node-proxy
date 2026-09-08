// =============================================================================
// CircuitBreaker - Auto-isolates failing clients
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; Node 24 type
// stripping runs it via require('./lib/circuit-breaker.ts').
// =============================================================================

import type { ServerConfig } from './config.ts';
import type { AppLogger } from './logger.ts';

export const STATE = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 } as const;
export type CircuitStateValue = (typeof STATE)[keyof typeof STATE];

interface CircuitEntry {
  state: CircuitStateValue;
  failures: number;
  lastFailure: number;
  successes: number;
  halfOpenAttempts: number;
  openedAt: number;
  windowStart: number;
}

interface CircuitBreakerDefaults {
  error_threshold: number;
  window_ms: number;
  recovery_timeout_ms: number;
  half_open_max_attempts: number;
}

const STATE_NAMES = ['closed', 'open', 'half_open'] as const;

export class CircuitBreaker {
  config: ServerConfig;
  log: AppLogger;
  // clientId -> state entry
  private states: Map<string, CircuitEntry> = new Map();
  private _defaults: CircuitBreakerDefaults;

  constructor(config: ServerConfig, logger: AppLogger) {
    this.config = config;
    this.log = logger;
    this._defaults = {
      error_threshold: config.circuit_breaker?.error_threshold || 5,
      window_ms: config.circuit_breaker?.window_ms || 60000,
      recovery_timeout_ms: config.circuit_breaker?.recovery_timeout_ms || 30000,
      half_open_max_attempts: config.circuit_breaker?.half_open_max_attempts || 3,
    };
  }

  private _get(clientId: string): CircuitEntry {
    let cb = this.states.get(clientId);
    if (!cb) {
      cb = {
        state: STATE.CLOSED,
        failures: 0,
        lastFailure: 0,
        successes: 0,
        halfOpenAttempts: 0,
        openedAt: 0,
        windowStart: Date.now(),
      };
      this.states.set(clientId, cb);
    }
    return cb;
  }

  // Called when a request succeeds
  onSuccess(clientId: string) {
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
  onFailure(clientId: string) {
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
        this.log.warn(
          {
            clientId,
            failures: cb.failures,
            window: this._defaults.window_ms,
          },
          'Circuit breaker: client OPENED'
        );
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
  isAllowed(clientId: string): boolean {
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
    return true;
  }

  getState(clientId: string): string {
    const cb = this.states.get(clientId);
    if (!cb) return 'closed';
    return STATE_NAMES[cb.state] || 'unknown';
  }

  getStatus(clientId: string): Record<string, unknown> {
    const cb = this.states.get(clientId);
    if (!cb) return { state: 'closed', failures: 0 };
    return {
      state: STATE_NAMES[cb.state],
      failures: cb.failures,
      lastFailure: cb.lastFailure,
      openedAt: cb.openedAt,
      halfOpenAttempts: cb.halfOpenAttempts,
    };
  }

  getAllStatuses(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const id of this.states.keys()) {
      result[id] = this.getStatus(id);
    }
    return result;
  }

  // Manually reset a client's circuit breaker
  reset(clientId: string) {
    this.states.delete(clientId);
    this.log.info({ clientId }, 'Circuit breaker: manually reset');
  }

  // Hot-update threshold parameters (used by the web settings panel)
  updateConfig(partial: Partial<CircuitBreakerDefaults> = {}): CircuitBreakerDefaults {
    const merged = { ...this._defaults, ...partial };
    this._defaults = {
      error_threshold: merged.error_threshold,
      window_ms: merged.window_ms,
      recovery_timeout_ms: merged.recovery_timeout_ms,
      half_open_max_attempts: merged.half_open_max_attempts,
    };
    // Keep the shared config object in sync so GET /config reflects it
    if (this.config.circuit_breaker) {
      Object.assign(this.config.circuit_breaker, this._defaults);
    }
    this.log.info({ config: this._defaults }, 'Circuit breaker config updated');
    return { ...this._defaults };
  }

  getEffectiveConfig(): CircuitBreakerDefaults {
    return { ...this._defaults };
  }

  // Cleanup stale entries
  cleanup(activeClientIds: Iterable<string>) {
    const activeSet = new Set(activeClientIds);
    for (const id of this.states.keys()) {
      if (!activeSet.has(id)) {
        this.states.delete(id);
      }
    }
  }
}
