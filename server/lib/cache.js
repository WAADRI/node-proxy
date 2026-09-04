// =============================================================================
// Cache - Request cache with deduplication and TTL
// =============================================================================
'use strict';

class RequestCache {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.cache = new Map(); // key -> { data, statusCode, headers, createdAt, ttl, hits }
    this.pending = new Map(); // key -> [{ resolve, reject }] - dedup concurrent requests
    this.enabled = config.cache?.enabled !== false;
    this.defaultTTL = config.cache?.default_ttl || 5000; // 5 seconds
    this.maxSize = config.cache?.max_size || 5000;
    this.maxBodySize = config.cache?.max_body_size || 1024 * 1024; // 1MB max cached body
    this._cleanupTimer = null;

    if (this.enabled) {
      this._cleanupTimer = setInterval(() => this._cleanup(), 30000);
      this.log.info({ defaultTTL: this.defaultTTL, maxSize: this.maxSize }, 'Request cache enabled');
    }
  }

  // Generate a cache key from request parameters
  makeKey(method, url, headers, body) {
    // Only cache GET requests by default
    if (method !== 'GET') return null;
    // Never use the shared cache for credentialed requests: the response may
    // be personalized (Cookie / Authorization) and must not be served to or
    // polluted by other users.
    const h = headers || {};
    const hasHeader = (name) => {
      if (h[name] !== undefined) return true;
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === name) return true;
      }
      return false;
    };
    if (hasHeader('authorization') || hasHeader('cookie')) return null;
    // Normalize URL
    const urlObj = new URL(url);
    const sorted = new URLSearchParams(urlObj.searchParams);
    sorted.sort();
    const normalized = `${urlObj.origin}${urlObj.pathname}?${sorted.toString()}`;
    // Include Accept header for content negotiation
    const accept = h['accept'] || '';
    return `${method}:${normalized}:${accept}`;
  }

  // Try to get from cache. Returns { hit, data, statusCode, headers } or null.
  get(key) {
    if (!this.enabled || !key) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    entry.hits++;
    return {
      hit: true,
      data: entry.data,
      statusCode: entry.statusCode,
      headers: entry.headers,
      age: Date.now() - entry.createdAt,
    };
  }

  // Set cache entry
  set(key, data, statusCode, headers, ttl) {
    if (!this.enabled || !key) return;
    // Don't cache error responses
    if (statusCode >= 400) return;
    // Don't cache large bodies
    if (data && data.length > this.maxBodySize) return;
    // Respect cache directives of the response (RFC 7234, simplified)
    if (!this._isCacheableResponse(headers)) return;
    // Evict if full
    if (this.cache.size >= this.maxSize) {
      this._evictOne();
    }
    this.cache.set(key, {
      data,
      statusCode,
      headers: sanitizeCacheHeaders(headers),
      createdAt: Date.now(),
      ttl: ttl || this.defaultTTL,
      hits: 0,
    });
  }

  // Decide whether a response may be stored in the shared cache.
  // Private responses (Set-Cookie, private/no-store/no-cache) and responses
  // varying on request headers other than Accept are rejected, otherwise a
  // response meant for one user could be served to another.
  _isCacheableResponse(headers) {
    if (!headers) return true;
    const get = (name) => {
      const v = headers[name];
      if (v !== undefined) return v;
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === name) return headers[k];
      }
      return undefined;
    };
    const cc = get('cache-control');
    if (cc !== undefined) {
      const tokens = String(cc)
        .split(',')
        .map((t) => t.trim().toLowerCase());
      if (tokens.includes('no-store') || tokens.includes('private') || tokens.includes('no-cache')) {
        return false;
      }
    }
    if (get('set-cookie') !== undefined) return false;
    const vary = get('vary');
    if (vary !== undefined) {
      const fields = String(vary)
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      // Only Accept is part of the cache key; any other field (or *) means the
      // response depends on request headers we do not key on -> not shared-safe.
      if (fields.some((f) => f !== 'accept')) return false;
    }
    return true;
  }

  // Invalidate cache entries matching a pattern
  invalidate(pattern) {
    if (!this.enabled) return 0;
    let count = 0;
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    for (const [key] of this.cache) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  clear() {
    this.cache.clear();
    this.pending.clear();
  }

  stats() {
    let totalHits = 0;
    let expired = 0;
    const now = Date.now();
    for (const [, entry] of this.cache) {
      totalHits += entry.hits;
      if (now - entry.createdAt > entry.ttl) expired++;
    }
    return {
      size: this.cache.size,
      pending: this.pending.size,
      totalHits,
      expired,
      enabled: this.enabled,
      defaultTTL: this.defaultTTL,
      maxSize: this.maxSize,
    };
  }

  // ===========================================================================
  // Deduplication: avoid duplicate concurrent requests
  // ===========================================================================
  // Returns a promise that resolves when the request is done.
  // If the same key is already in flight, waits for the existing request.
  dedup(key, fetcher) {
    if (!this.enabled || !key) return fetcher();

    // Check cache first
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);

    // Check if already pending
    const pending = this.pending.get(key);
    if (pending) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    }

    // Start new request
    const queue = [];
    this.pending.set(key, queue);

    return fetcher().then((result) => {
      // Cache the result
      if (result && result.data) {
        this.set(key, result.data, result.statusCode, result.headers, result.ttl);
      }
      // Resolve all waiters
      this.pending.delete(key);
      for (const w of queue) w.resolve(result);
      return result;
    }).catch((err) => {
      this.pending.delete(key);
      for (const w of queue) w.reject(err);
      throw err;
    });
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  _evictOne() {
    // Evict oldest entry or least accessed
    let oldest = null;
    let oldestKey = null;
    for (const [key, entry] of this.cache) {
      if (!oldest || entry.createdAt < oldest.createdAt) {
        oldest = entry;
        oldestKey = key;
      }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }

  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this.cache.clear();
    this.pending.clear();
  }
}

function sanitizeCacheHeaders(headers) {
  if (!headers) return {};
  const safe = {};
  const allowed = ['content-type', 'content-encoding', 'content-language', 'cache-control', 'etag', 'last-modified'];
  for (const [k, v] of Object.entries(headers)) {
    if (allowed.includes(k.toLowerCase())) safe[k] = v;
  }
  return safe;
}

module.exports = { RequestCache };