// =============================================================================
// LogHub - Recent request log ring buffer with live change notification
// Feeds the management panel "request log" view (initial fetch + WS push)
// =============================================================================
'use strict';

class LogHub {
  constructor(logger, { maxEntries = 500 } = {}) {
    this.log = logger;
    this.maxEntries = maxEntries;
    this.entries = [];
    this._seq = 0;
    this._listeners = new Set();
  }

  // Record one proxy request event
  record(entry) {
    const e = {
      seq: ++this._seq,
      ts: entry.ts || Date.now(),
      ip: entry.ip || '',
      method: entry.method || 'GET',
      url: entry.url || '',
      status: entry.status || 0,
      ms: entry.ms || 0,
    };
    this.entries.push(e);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    for (const cb of this._listeners) {
      try { cb(e); } catch (_) {}
    }
    return e;
  }

  getRecent(limit = 100) {
    return this.entries.slice(-limit);
  }

  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  clear() {
    this.entries = [];
  }
}

module.exports = { LogHub };
