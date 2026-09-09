// =============================================================================
// Audit Logger - Comprehensive request audit logging
// Phase 3: Request Audit Log
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose - this
// module is loaded via CommonJS require() from server.js under Node >= 24 type
// stripping, so only type imports are allowed (no value imports/exports) and
// callers keep using require('./lib/audit.ts').
// =============================================================================

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs');
const path = require('path');
const os = require('os');
import type { AppLogger } from './logger.ts';
import type { ServerConfig } from './config.ts';

// --- Minimal audit config section. ServerConfig declares `audit?: unknown`, so
// --- this module narrows it to the shape it actually reads from config. ------
interface AuditSection {
  enabled?: boolean;
  dir?: string;
  max_size?: number;
  max_files?: number;
  buffer_size?: number;
}

// --- Data accepted by each public logging method (all fields optional) -------
interface RequestLogData {
  clientId?: string;
  clientTags?: string[];
  username?: string;
  method?: string;
  url?: string;
  host?: string;
  port?: number;
  protocol?: string;
  sourceIp?: string;
  targetIp?: string;
  requestId?: string;
  tunnelId?: string;
  status?: string;
  statusCode?: number;
  duration?: number;
  bytesSent?: number;
  bytesReceived?: number;
  error?: string;
  ruleMatch?: string;
}

interface ClientEventLogData {
  clientId?: string;
  clientTags?: string[];
  event?: string;
  info?: string;
  version?: string;
  ip?: string;
  reason?: string;
}

interface AuthLogData {
  username?: string;
  sourceIp?: string;
  action?: string;
  success?: boolean;
  reason?: string;
  role?: string;
}

interface SystemLogData {
  event?: string;
  message?: string;
  details?: Record<string, unknown>;
}

// --- Audit log entries (each buffered entry is written as one JSON line) -----
interface RequestEntry {
  type: string;
  timestamp: string;
  hostname: string;
  clientId: string;
  clientTags: string[];
  username: string;
  method: string;
  url: string;
  host: string;
  port: number;
  protocol: string;
  sourceIp: string;
  targetIp: string;
  requestId: string;
  tunnelId: string;
  status: string;
  statusCode: number;
  duration: number;
  bytesSent: number;
  bytesReceived: number;
  error: string;
  ruleMatch: string;
}

interface ClientEventEntry {
  type: string;
  timestamp: string;
  hostname: string;
  clientId: string;
  clientTags: string[];
  event: string;
  info: string;
  ip: string;
  reason: string;
}

interface AuthEntry {
  type: string;
  timestamp: string;
  hostname: string;
  username: string;
  sourceIp: string;
  action: string;
  success: boolean;
  reason: string;
  role: string;
}

interface SystemEntry {
  type: string;
  timestamp: string;
  hostname: string;
  event: string;
  message: string;
  details: Record<string, unknown>;
}

type AuditLogEntry = RequestEntry | ClientEventEntry | AuthEntry | SystemEntry;

// Structural view of a record parsed back from the log file. query() only reads
// these fields to filter/sort; extra fields written by older records are kept
// untouched and passed through to the caller as-is.
interface AuditQueryRecord {
  type: string;
  timestamp: string;
  clientId?: string;
  username?: string;
}

interface AuditQueryOptions {
  type?: string;
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
  clientId?: string;
  username?: string;
}

interface AuditQueryResult {
  entries: AuditQueryRecord[];
  total: number;
  offset: number;
  limit: number;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class AuditLogger {
  log: AppLogger;
  enabled: boolean;
  logDir: string;
  logFile: string;
  maxSize: number;
  maxFiles: number;
  bufferSize: number;
  buffer: AuditLogEntry[];
  _flushInterval: ReturnType<typeof setInterval> | null;
  _currentSize: number;
  _hostname: string;

  constructor(config: ServerConfig, logger: AppLogger) {
    this.log = logger;
    const auditCfg = (config.audit ?? {}) as AuditSection;
    this.enabled = auditCfg.enabled !== false;
    this.logDir = auditCfg.dir || path.join(process.cwd(), 'audit');
    this.logFile = path.join(this.logDir, 'audit.log');
    this.maxSize = auditCfg.max_size || 50 * 1024 * 1024; // 50MB
    this.maxFiles = auditCfg.max_files || 5;
    this.bufferSize = auditCfg.buffer_size || 100;
    this.buffer = [];
    this._flushInterval = null;
    this._currentSize = 0;
    this._hostname = os.hostname();

    if (this.enabled) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
        // Get current log file size
        try {
          const stats = fs.statSync(this.logFile);
          this._currentSize = stats.size;
        } catch (_) {
          this._currentSize = 0;
        }
        // Start periodic flush
        this._flushInterval = setInterval(() => this._flush(), 5000);
        this._flushInterval.unref();
        this.log.info({ dir: this.logDir }, 'Audit logging enabled');
      } catch (err) {
        this.log.error({ error: errorMessage(err) }, 'Failed to initialize audit log');
        this.enabled = false;
      }
    }
  }

  /**
   * Log a proxy request
   */
  logRequest(data: RequestLogData) {
    if (!this.enabled) return;
    const entry: RequestEntry = {
      type: 'request',
      timestamp: new Date().toISOString(),
      hostname: this._hostname,
      clientId: data.clientId || '',
      clientTags: data.clientTags || [],
      username: data.username || '',
      method: data.method || '',
      url: data.url || '',
      host: data.host || '',
      port: data.port || 0,
      protocol: data.protocol || 'http', // http, socks5, udp
      sourceIp: data.sourceIp || '',
      targetIp: data.targetIp || '',
      requestId: data.requestId || '',
      tunnelId: data.tunnelId || '',
      status: data.status || 'pending', // pending, success, error, denied, timeout
      statusCode: data.statusCode || 0,
      duration: data.duration || 0,
      bytesSent: data.bytesSent || 0,
      bytesReceived: data.bytesReceived || 0,
      error: data.error || '',
      ruleMatch: data.ruleMatch || '', // ACL rule that matched
    };
    this.buffer.push(entry);
    if (this.buffer.length >= this.bufferSize) {
      this._flush();
    }
  }

  /**
   * Log client connection/disconnection
   */
  logClientEvent(data: ClientEventLogData) {
    if (!this.enabled) return;
    const entry: ClientEventEntry = {
      type: 'client_event',
      timestamp: new Date().toISOString(),
      hostname: this._hostname,
      clientId: data.clientId || '',
      clientTags: data.clientTags || [],
      event: data.event || '', // connect, disconnect, auth, error, update
      info: data.info || data.version || '',
      ip: data.ip || '',
      reason: data.reason || '',
    };
    this.buffer.push(entry);
  }

  /**
   * Log authentication events
   */
  logAuth(data: AuthLogData) {
    if (!this.enabled) return;
    const entry: AuthEntry = {
      type: 'auth',
      timestamp: new Date().toISOString(),
      hostname: this._hostname,
      username: data.username || '',
      sourceIp: data.sourceIp || '',
      action: data.action || '', // login, logout, fail, proxy_auth, socks5_auth
      success: data.success || false,
      reason: data.reason || '',
      role: data.role || '',
    };
    this.buffer.push(entry);
  }

  /**
   * Log system events
   */
  logSystem(data: SystemLogData) {
    if (!this.enabled) return;
    const entry: SystemEntry = {
      type: 'system',
      timestamp: new Date().toISOString(),
      hostname: this._hostname,
      event: data.event || '', // start, stop, config_change, error, warning
      message: data.message || '',
      details: data.details || {},
    };
    this.buffer.push(entry);
  }

  /**
   * Flush buffered entries to disk
   */
  _flush() {
    if (!this.enabled || this.buffer.length === 0) return;
    const entries = this.buffer.splice(0);
    try {
      const output = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      // Check if rotation is needed
      this._currentSize += Buffer.byteLength(output, 'utf8');
      if (this._currentSize > this.maxSize) {
        this._rotate();
      }
      fs.appendFileSync(this.logFile, output, 'utf8');
    } catch (err) {
      this.log.error({ error: errorMessage(err) }, 'Failed to write audit log');
      // Put entries back in buffer
      this.buffer.unshift(...entries);
    }
  }

  /**
   * Rotate log files
   */
  _rotate() {
    try {
      // Remove oldest file
      const oldest = path.join(this.logDir, `audit.${this.maxFiles}.log`);
      try { fs.unlinkSync(oldest); } catch (_) {}

      // Shift files
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const oldFile = path.join(this.logDir, `audit.${i}.log`);
        const newFile = path.join(this.logDir, `audit.${i + 1}.log`);
        try { fs.renameSync(oldFile, newFile); } catch (_) {}
      }

      // Rename current log
      const current = this.logFile;
      const rotated = path.join(this.logDir, 'audit.1.log');
      try { fs.renameSync(current, rotated); } catch (_) {}

      this._currentSize = 0;
    } catch (err) {
      this.log.error({ error: errorMessage(err) }, 'Failed to rotate audit log');
    }
  }

  /**
   * Query audit log entries (for API)
   */
  query(options: AuditQueryOptions = {}): AuditQueryResult {
    const { type, limit = 100, offset = 0, since, until, clientId, username } = options;
    try {
      // Read from current log file
      const data: string = fs.readFileSync(this.logFile, 'utf8');
      const lines = data.trim().split('\n').filter(Boolean);
      let entries = lines
        .map((line): AuditQueryRecord | null => {
          try {
            return JSON.parse(line) as AuditQueryRecord;
          } catch (_) {
            return null;
          }
        })
        .filter((e): e is AuditQueryRecord => Boolean(e));

      // Apply filters
      if (type) entries = entries.filter((e) => e.type === type);
      if (since) entries = entries.filter((e) => new Date(e.timestamp) >= new Date(since));
      if (until) entries = entries.filter((e) => new Date(e.timestamp) <= new Date(until));
      if (clientId) entries = entries.filter((e) => e.clientId === clientId);
      if (username) entries = entries.filter((e) => e.username === username);

      // Sort by timestamp descending
      entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Paginate
      const total = entries.length;
      entries = entries.slice(offset, offset + limit);

      return { entries, total, offset, limit };
    } catch (err) {
      return { entries: [], total: 0, offset, limit, error: errorMessage(err) };
    }
  }

  /**
   * Get audit log statistics
   */
  getStats() {
    return {
      enabled: this.enabled,
      bufferSize: this.buffer.length,
      currentLogSize: this._currentSize,
      logFile: this.logFile,
      logDir: this.logDir,
    };
  }

  /**
   * Cleanup
   */
  shutdown() {
    if (this._flushInterval) {
      clearInterval(this._flushInterval);
      this._flushInterval = null;
    }
    this._flush();
    this.log.info('Audit logger shut down');
  }
}

module.exports = { AuditLogger };
