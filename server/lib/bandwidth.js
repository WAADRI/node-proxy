// =============================================================================
// BandwidthLimiter - Token bucket rate limiter per client
// =============================================================================
'use strict';

class TokenBucket {
  constructor(rateBytesPerSec, burstBytes) {
    this.rate = rateBytesPerSec; // bytes per second
    this.burst = burstBytes || rateBytesPerSec; // max burst size
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  // Try to consume tokens; returns true if allowed, false if rate limited
  tryConsume(bytes) {
    this._refill();
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      // this.used += bytes; (tracked by caller)
      return true;
    }
    return false;
  }

  // Get wait time until enough tokens are available
  getWaitTime(bytes) {
    this._refill();
    if (this.tokens >= bytes) return 0;
    const needed = bytes - this.tokens;
    return (needed / this.rate) * 1000; // ms
  }

  get utilization() {
    return this.rate > 0 ? (1 - this.tokens / this.burst) : 0;
  }
}

class BandwidthLimiter {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.buckets = new Map(); // clientId -> TokenBucket
    this.globalBucket = null;

    const bw = config.bandwidth || {};
    this.enabled = bw.enabled || false;
    this.defaultRate = bw.default_rate || 1024 * 1024; // 1 MB/s
    this.defaultBurst = bw.default_burst || 5 * 1024 * 1024; // 5 MB
    this.globalRate = bw.global_rate || 0; // 0 = unlimited
    this.globalBurst = bw.global_burst || 50 * 1024 * 1024; // 50 MB

    if (this.globalRate > 0) {
      this.globalBucket = new TokenBucket(this.globalRate, this.globalBurst);
    }

    // Per-client overrides
    this.overrides = new Map(); // clientId -> { rate, burst }
  }

  // Check if a client can send `bytes` bytes
  check(clientId, bytes) {
    if (!this.enabled) return true;

    // Check global limit
    if (this.globalBucket && !this.globalBucket.tryConsume(bytes)) {
      return false;
    }

    // Check per-client limit
    let rate = this.defaultRate;
    let burst = this.defaultBurst;

    if (this.overrides.has(clientId)) {
      const override = this.overrides.get(clientId);
      rate = override.rate || rate;
      burst = override.burst || burst;
    }

    if (!this.buckets.has(clientId)) {
      this.buckets.set(clientId, new TokenBucket(rate, burst));
    }

    return this.buckets.get(clientId).tryConsume(bytes);
  }

  // Set per-client bandwidth limit
  setLimit(clientId, rateBytesPerSec, burstBytes) {
    this.overrides.set(clientId, {
      rate: rateBytesPerSec,
      burst: burstBytes || rateBytesPerSec,
    });
    // Reset bucket
    this.buckets.set(clientId, new TokenBucket(rateBytesPerSec, burstBytes || rateBytesPerSec));
  }

  removeLimit(clientId) {
    this.overrides.delete(clientId);
    this.buckets.delete(clientId);
  }

  getUtilization(clientId) {
    const bucket = this.buckets.get(clientId);
    if (!bucket) return 0;
    return bucket.utilization;
  }

  getStats() {
    const result = { global: null, clients: {} };
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

  cleanup(activeClientIds) {
    const activeSet = new Set(activeClientIds);
    for (const [id] of this.buckets) {
      if (!activeSet.has(id)) this.buckets.delete(id);
    }
  }
}

module.exports = { BandwidthLimiter, TokenBucket };