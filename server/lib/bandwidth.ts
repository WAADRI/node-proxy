// =============================================================================
// BandwidthLimiter - Token bucket rate limiter per client
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; Node 24 type
// stripping runs it via require('./lib/bandwidth.ts').
// =============================================================================

import type { ServerConfig, BandwidthSection } from './config.ts';
import type { AppLogger } from './logger.ts';

export interface BucketStats {
  rate: number;
  burst: number;
  utilization: number;
}

export class TokenBucket {
  rate: number; // bytes per second
  burst: number; // max burst size
  private tokens: number;
  private lastRefill: number;

  constructor(rateBytesPerSec: number, burstBytes?: number) {
    this.rate = rateBytesPerSec;
    this.burst = burstBytes || rateBytesPerSec;
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  private _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  // Try to consume tokens; returns true if allowed, false if rate limited
  tryConsume(bytes: number): boolean {
    this._refill();
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return true;
    }
    return false;
  }

  // Get wait time until enough tokens are available
  getWaitTime(bytes: number): number {
    this._refill();
    if (this.tokens >= bytes) return 0;
    const needed = bytes - this.tokens;
    return (needed / this.rate) * 1000; // ms
  }

  get utilization(): number {
    return this.rate > 0 ? 1 - this.tokens / this.burst : 0;
  }
}

interface BucketOverride {
  rate: number;
  burst: number;
}

interface BandwidthSettings {
  enabled: boolean;
  default_rate: number;
  default_burst: number;
  global_rate: number;
  global_burst: number;
}

export class BandwidthLimiter {
  config: ServerConfig;
  log: AppLogger;
  private buckets: Map<string, TokenBucket> = new Map(); // clientId -> TokenBucket
  private globalBucket: TokenBucket | null = null;
  private overrides: Map<string, BucketOverride> = new Map(); // clientId -> { rate, burst }

  enabled: boolean;
  defaultRate: number;
  defaultBurst: number;
  globalRate: number;
  globalBurst: number;

  constructor(config: ServerConfig, logger: AppLogger) {
    this.config = config;
    this.log = logger;

    const bw: Partial<BandwidthSection> = config.bandwidth ?? {};
    this.enabled = bw.enabled || false;
    this.defaultRate = bw.default_rate || 1024 * 1024; // 1 MB/s
    this.defaultBurst = bw.default_burst || 5 * 1024 * 1024; // 5 MB
    this.globalRate = bw.global_rate || 0; // 0 = unlimited
    this.globalBurst = bw.global_burst || 50 * 1024 * 1024; // 50 MB

    if (this.globalRate > 0) {
      this.globalBucket = new TokenBucket(this.globalRate, this.globalBurst);
    }
  }

  // Check if a client can send `bytes` bytes
  check(clientId: string, bytes: number): boolean {
    if (!this.enabled) return true;

    // Check global limit
    if (this.globalBucket && !this.globalBucket.tryConsume(bytes)) {
      return false;
    }

    // Check per-client limit
    let rate = this.defaultRate;
    let burst = this.defaultBurst;

    const override = this.overrides.get(clientId);
    if (override) {
      rate = override.rate || rate;
      burst = override.burst || burst;
    }

    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      bucket = new TokenBucket(rate, burst);
      this.buckets.set(clientId, bucket);
    }

    return bucket.tryConsume(bytes);
  }

  // Set per-client bandwidth limit
  setLimit(clientId: string, rateBytesPerSec: number, burstBytes?: number) {
    this.overrides.set(clientId, {
      rate: rateBytesPerSec,
      burst: burstBytes || rateBytesPerSec,
    });
    // Reset bucket
    this.buckets.set(clientId, new TokenBucket(rateBytesPerSec, burstBytes || rateBytesPerSec));
  }

  // Hot-update global bandwidth settings (used by the web settings panel)
  updateConfig(partial: Partial<BandwidthSettings> = {}): BandwidthSettings {
    const bw: BandwidthSettings = {
      enabled: this.enabled,
      default_rate: this.defaultRate,
      default_burst: this.defaultBurst,
      global_rate: this.globalRate,
      global_burst: this.globalBurst,
      ...partial,
    };
    this.enabled = !!bw.enabled;
    this.defaultRate = bw.default_rate;
    this.defaultBurst = bw.default_burst;
    this.globalRate = bw.global_rate;
    this.globalBurst = bw.global_burst;
    // Keep the shared config object in sync so GET /config reflects it
    if (this.config.bandwidth) Object.assign(this.config.bandwidth, bw);
    // Rebuild the global token bucket when the limit changes
    if (this.globalRate > 0) {
      this.globalBucket = new TokenBucket(this.globalRate, this.globalBurst);
    } else {
      this.globalBucket = null;
    }
    this.log.info({ config: this.getEffectiveConfig() }, 'Bandwidth config updated');
    return this.getEffectiveConfig();
  }

  getEffectiveConfig(): BandwidthSettings {
    return {
      enabled: this.enabled,
      default_rate: this.defaultRate,
      default_burst: this.defaultBurst,
      global_rate: this.globalRate,
      global_burst: this.globalBurst,
    };
  }

  removeLimit(clientId: string) {
    this.overrides.delete(clientId);
    this.buckets.delete(clientId);
  }

  getUtilization(clientId: string): number {
    const bucket = this.buckets.get(clientId);
    if (!bucket) return 0;
    return bucket.utilization;
  }

  getStats(): { global: BucketStats | null; clients: Record<string, BucketStats> } {
    const result: { global: BucketStats | null; clients: Record<string, BucketStats> } = {
      global: null,
      clients: {},
    };
    if (this.globalBucket) {
      result.global = {
        rate: this.globalBucket.rate,
        burst: this.globalBucket.burst,
        utilization: this.globalBucket.utilization,
      };
    }
    for (const [id, bucket] of this.buckets) {
      result.clients[id] = {
        rate: bucket.rate,
        burst: bucket.burst,
        utilization: bucket.utilization,
      };
    }
    return result;
  }

  cleanup(activeClientIds: Iterable<string>) {
    const activeSet = new Set(activeClientIds);
    for (const id of this.buckets.keys()) {
      if (!activeSet.has(id)) this.buckets.delete(id);
    }
  }
}
