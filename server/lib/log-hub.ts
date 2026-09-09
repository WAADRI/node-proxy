// =============================================================================
// LogHub - Recent request log ring buffer with live change notification
// Feeds the management panel "request log" view (initial fetch + WS push)
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose:
// Node type stripping loads this file as CommonJS; callers use
// require('./lib/log-hub.ts').
// =============================================================================

'use strict';

 

import type { AppLogger } from './logger.ts';

// Callers push a subset of fields; record() normalizes with the same defaults
// as the original JS.
interface LogEntryInput {
  kind?: string;
  ts?: number;
  ip?: string;
  method?: string;
  url?: string;
  status?: number;
  ms?: number;
}

interface LogEntry {
  seq: number;
  kind: string;
  ts: number;
  ip: string;
  method: string;
  url: string;
  status: number;
  ms: number;
}

type LogListener = (entry: LogEntry) => void;

class LogHub {
  log: AppLogger;
  maxEntries: number;
  entries: LogEntry[];
  _seq: number;
  _listeners: Set<LogListener>;

  constructor(logger: AppLogger, { maxEntries = 500 }: { maxEntries?: number } = {}) {
    this.log = logger;
    this.maxEntries = maxEntries;
    this.entries = [];
    this._seq = 0;
    this._listeners = new Set();
  }

  // Record one proxy request event
  record(entry: LogEntryInput): LogEntry {
    const e: LogEntry = {
      seq: ++this._seq,
      kind: entry.kind || 'http',
      ts: entry.ts || Date.now(),
      ip: String(entry.ip || '').replace(/^::ffff:/i, ''),
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

  getRecent(limit = 100): LogEntry[] {
    return this.entries.slice(-limit);
  }

  onChange(cb: LogListener): () => boolean {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  clear(): void {
    this.entries = [];
  }
}

module.exports = { LogHub };
