// =============================================================================
// SettingsManager - runtime-adjustable server configuration
//
// The web panel can adjust a whitelist of live parameters (routing strategy,
// circuit breaker thresholds, global bandwidth, per-client timeouts/concurrency,
// cache TTL). Every change is:
//   1. applied live to the running module (no restart),
//   2. written into storage.config_overrides so it survives restarts,
//   3. reversible via reset() which restores the boot-time (config.yaml/env) value.
//
// Parameters that cannot be changed at runtime (ports, auth token, ...) are
// exposed read-only by list() so the panel can show "change requires editing
// config.yaml + restart".
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose: the
// file keeps CommonJS (module.exports) so Node type stripping loads it directly;
// only type-only imports are used (stripped at load, no ESM flip).
// =============================================================================
'use strict';

 

import type { AppLogger } from './logger.ts';
import type { ServerConfig } from './config.ts';

// --- Structural contracts for the collaborating modules -----------------------
// Duck-typed minimal shapes: storage/router/circuitBreaker/bandwidthLimiter/
// cache are plain CJS modules (some not yet migrated); only the surface this
// file touches is declared, so no value-level require/import is needed here.

interface SettingsStorageLike {
  available: boolean;
  getConfigOverride(key: string): unknown;
  setConfigOverride(key: string, value: unknown): void;
  deleteConfigOverride(key: string): void;
}

interface SettingsRouterLike {
  getStrategy(): string;
  setStrategy(strategy: string): boolean;
}

interface SettingsCircuitBreakerLike {
  getEffectiveConfig(): unknown;
  updateConfig(config: unknown): unknown;
}

interface SettingsBandwidthLimiterLike {
  getEffectiveConfig(): unknown;
  updateConfig(config: unknown): unknown;
}

interface SettingsCacheLike {
  defaultTTL: number | undefined;
}

interface SettingsModules {
  router: SettingsRouterLike | null;
  circuitBreaker: SettingsCircuitBreakerLike | null;
  bandwidthLimiter: SettingsBandwidthLimiterLike | null;
  cache: SettingsCacheLike | null;
}

// Values accepted by apply(): one entry per runtime-adjustable field. Entries
// stay opaque (unknown) - each apply() branch validates its own fields.
interface SettingsValues {
  strategy?: unknown;
  enabled?: unknown;
  error_threshold?: unknown;
  window_ms?: unknown;
  recovery_timeout_ms?: unknown;
  half_open_max_attempts?: unknown;
  default_rate?: unknown;
  default_burst?: unknown;
  global_rate?: unknown;
  global_burst?: unknown;
  request_timeout?: unknown;
  tunnel_timeout?: unknown;
  tunnel_idle_timeout?: unknown;
  max_concurrent?: unknown;
  default_ttl?: unknown;
}

// _numFields outcome: either an error or the validated numeric fields.
type NumFieldsResult =
  | { error: string; values?: never }
  | { error?: never; values: Record<string, number> };

const ROUTING_STRATEGIES: string[] = ['random', 'least-loaded', 'fastest-response', 'weighted'];

// config_overrides key per settings group (routing keeps its legacy plain key)
const OVERRIDE_KEYS: Record<string, string> = {
  routing: 'routing_strategy',
  circuit_breaker: 'circuit_breaker_config',
  bandwidth: 'bandwidth_config',
  client: 'client_config',
  cache: 'cache_config',
};

// Groups whose values are plain scalars vs objects persisted as JSON
const GROUPS: string[] = ['routing', 'circuit_breaker', 'bandwidth', 'client', 'cache'];

class SettingsManager {
  config: ServerConfig;
  storage: SettingsStorageLike | null;
  modules: SettingsModules;
  log: AppLogger;
  baseConfig: ServerConfig;

  constructor(config: ServerConfig, storage: SettingsStorageLike | null, modules: SettingsModules, logger: AppLogger) {
    this.config = config;
    this.storage = storage;
    this.modules = modules; // { router, circuitBreaker, bandwidthLimiter, cache }
    this.log = logger;
    // Boot-time config is the source of truth for "reset to default"
    this.baseConfig = JSON.parse(JSON.stringify(config)) as ServerConfig;
  }

  // ---------------------------------------------------------------------------
  // Boot: re-apply persisted overrides so hot settings survive a restart
  // ---------------------------------------------------------------------------
  applyPersisted() {
    if (!this.storage || !this.storage.available) return;
    try {
      for (const group of GROUPS) {
        const raw = this.storage.getConfigOverride(OVERRIDE_KEYS[group]);
        if (raw == null) continue;
        const value = group === 'routing' ? { strategy: String(raw) } : raw;
        if (value && typeof value === 'object') {
          this.apply(group, value, true);
        }
      }
      this.log.info('Runtime settings restored from storage');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message }, 'Failed to restore runtime settings');
    }
  }

  // ---------------------------------------------------------------------------
  // Read current effective state for the panel
  // ---------------------------------------------------------------------------
  list() {
    const m = this.modules;
    const c = this.config;

    const runtime = {
      routing: {
        strategy: this._effectiveStrategy(),
        available: ROUTING_STRATEGIES,
      },
      circuit_breaker: m.circuitBreaker ? m.circuitBreaker.getEffectiveConfig() : null,
      bandwidth: m.bandwidthLimiter ? m.bandwidthLimiter.getEffectiveConfig() : null,
      client: {
        request_timeout: c.client?.request_timeout,
        tunnel_timeout: c.client?.tunnel_timeout,
        tunnel_idle_timeout: c.client?.tunnel_idle_timeout,
        max_concurrent: c.client?.max_concurrent,
      },
      cache: { default_ttl: m.cache ? m.cache.defaultTTL : null },
    };

    const overrides: Record<string, boolean> = {};
    if (this.storage && this.storage.available) {
      for (const group of GROUPS) {
        overrides[group] = this.storage.getConfigOverride(OVERRIDE_KEYS[group]) != null;
      }
    }

    return {
      runtime,
      overrides,
      restart_only: {
        server: {
          host: c.server?.host,
          web_port: c.server?.web_port,
          http_proxy_port: c.server?.http_proxy_port,
          socks5_port: c.server?.socks5_port,
          ipv6_only: c.server?.ipv6_only,
        },
        auth: {
          web_enabled: c.auth?.web?.enabled,
          web_username: c.auth?.web?.username,
          token_configured: !!(c.auth?.token && c.auth.token !== 'node-proxy-default-token'),
        },
        logging_level: c.logging?.level,
      },
    };
  }

  _effectiveStrategy() {
    const m = this.modules;
    if (m.router && typeof m.router.getStrategy === 'function') return m.router.getStrategy();
    return this.config.routing?.strategy || 'random';
  }

  // ---------------------------------------------------------------------------
  // Apply a settings change for a group. Returns { ok, error? }
  // ---------------------------------------------------------------------------
  apply(group: string, values?: SettingsValues | null, silent = false) {
    if (!GROUPS.includes(group)) return { ok: false, error: 'Unknown settings group: ' + group };
    const v = values || {};

    switch (group) {
      case 'routing': {
        const strategy = String(v.strategy || '').trim();
        if (!ROUTING_STRATEGIES.includes(strategy)) {
          return { ok: false, error: 'Invalid strategy. Choose one of: ' + ROUTING_STRATEGIES.join(', ') };
        }
        if (!this.modules.router) return { ok: false, error: 'Router not available' };
        if (!this.modules.router.setStrategy(strategy)) {
          return { ok: false, error: 'Router rejected strategy: ' + strategy };
        }
        // routing section exists whenever a routing change can be applied (same
        // unconditional write as the original JS)
        this.config.routing!.strategy = strategy;
        this._persist(group, strategy);
        break;
      }
      case 'circuit_breaker': {
        const num = this._numFields(v, ['error_threshold', 'window_ms', 'recovery_timeout_ms', 'half_open_max_attempts'], 1);
        if (num.error) return num;
        if (!this.modules.circuitBreaker) return { ok: false, error: 'Circuit breaker not available' };
        const applied = this.modules.circuitBreaker.updateConfig(num.values);
        this._persist(group, applied);
        break;
      }
      case 'bandwidth': {
        const num = this._numFields(v, ['default_rate', 'default_burst', 'global_rate', 'global_burst'], 0);
        if (num.error) return num;
        const patch: Record<string, number | boolean> = { ...num.values };
        if (v.enabled !== undefined) patch.enabled = !!v.enabled;
        if (!this.modules.bandwidthLimiter) return { ok: false, error: 'Bandwidth limiter not available' };
        const applied = this.modules.bandwidthLimiter.updateConfig(patch);
        this._persist(group, applied);
        break;
      }
      case 'client': {
        // tunnel_idle_timeout may be 0 to disable idle tunnel reclamation
        const isZeroIdle = String(v.tunnel_idle_timeout) === '0';
        const rest = isZeroIdle ? { ...v, tunnel_idle_timeout: undefined } : v;
        const num = this._numFields(rest, ['request_timeout', 'tunnel_timeout', 'tunnel_idle_timeout', 'max_concurrent'], 1);
        if (num.error) return num;
        const patch = { ...num.values };
        if (isZeroIdle) patch.tunnel_idle_timeout = 0;
        if (Object.keys(patch).length === 0) return { ok: false, error: 'No valid numeric fields provided' };
        this.config.client = { ...(this.config.client || {}), ...patch };
        this._persist(group, patch);
        break;
      }
      case 'cache': {
        const num = this._numFields(v, ['default_ttl'], 0);
        if (num.error) return num;
        if (this.modules.cache) this.modules.cache.defaultTTL = num.values!.default_ttl;
        this.config.cache = { ...(this.config.cache || {}), ...num.values };
        this._persist(group, num.values);
        break;
      }
      default:
        return { ok: false, error: 'Unknown group' };
    }

    if (!silent) this.log.info({ group, values }, 'Runtime settings updated via panel');
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Restore a group to its boot-time (config.yaml/env) value
  // ---------------------------------------------------------------------------
  reset(group: string) {
    if (!GROUPS.includes(group)) return { ok: false, error: 'Unknown settings group: ' + group };
    const base = this.baseConfig;

    switch (group) {
      case 'routing':
        if (this.modules.router) {
          this.modules.router.setStrategy(base.routing?.strategy || 'random');
        }
        this.config.routing!.strategy = base.routing?.strategy || 'random';
        break;
      case 'circuit_breaker':
        if (this.modules.circuitBreaker) {
          this.modules.circuitBreaker.updateConfig(base.circuit_breaker || {});
        }
        break;
      case 'bandwidth':
        if (this.modules.bandwidthLimiter) {
          this.modules.bandwidthLimiter.updateConfig(base.bandwidth || {});
        }
        break;
      case 'client':
        this.config.client = { ...(base.client || {}) };
        break;
      case 'cache':
        if (this.modules.cache) this.modules.cache.defaultTTL = base.cache?.default_ttl;
        this.config.cache = { ...(base.cache || {}) };
        break;
      default:
        return { ok: false, error: 'Unknown group' };
    }

    this._clear(group);
    this.log.info({ group }, 'Runtime settings reset to config.yaml defaults');
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  _numFields(v: SettingsValues, fields: readonly (keyof SettingsValues)[], min: number): NumFieldsResult {
    const values: Record<string, number> = {};
    for (const f of fields) {
      if (v[f] === undefined || v[f] === null || v[f] === '') continue;
      const n = Number(v[f]);
      if (!Number.isFinite(n) || n < min) {
        return { error: `Invalid value for ${f}: must be a number >= ${min}` };
      }
      values[f] = Math.round(n);
    }
    if (Object.keys(values).length === 0 && Object.keys(v).length > 0) {
      return { error: 'No valid numeric fields provided' };
    }
    return { values };
  }

  _persist(group: string, value: unknown) {
    if (!this.storage || !this.storage.available) return;
    this.storage.setConfigOverride(OVERRIDE_KEYS[group], value);
  }

  _clear(group: string) {
    if (!this.storage || !this.storage.available) return;
    this.storage.deleteConfigOverride(OVERRIDE_KEYS[group]);
  }
}

module.exports = { SettingsManager, GROUPS };
