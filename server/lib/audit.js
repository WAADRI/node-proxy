// =============================================================================
// Audit Logger - Comprehensive request audit logging
// Phase 3: Request Audit Log
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

class AuditLogger {
  constructor(config, logger) {
    this.log = logger;
    this.enabled = config.audit?.enabled !== false;
    this.logDir = config.audit?.dir || path.join(process.cwd(), 'audit');
    this.logFile = path.join(this.logDir, 'audit.log');
    this.maxSize = config.audit?.max_size || 50 * 1024 * 1024; // 50MB
    this.maxFiles = config.audit?.max_files || 5;
    this.bufferSize = config.audit?.buffer_size || 100;
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
        this.log.error({ error: err.message }, 'Failed to initialize audit log');
        this.enabled = false;
      }
    }
  }

  /**
   * Log a proxy request
   */
  logRequest(data) {
    if (!this.enabled) return;
    const entry = {
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
  logClientEvent(data) {
    if (!this.enabled) return;
    const entry = {
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
  logAuth(data) {
    if (!this.enabled) return;
    const entry = {
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
  logSystem(data) {
    if (!this.enabled) return;
    const entry = {
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
      let output = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      // Check if rotation is needed
      this._currentSize += Buffer.byteLength(output, 'utf8');
      if (this._currentSize > this.maxSize) {
        this._rotate();
      }
      fs.appendFileSync(this.logFile, output, 'utf8');
    } catch (err) {
      this.log.error({ error: err.message }, 'Failed to write audit log');
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
      this.log.error({ error: err.message }, 'Failed to rotate audit log');
    }
  }

  /**
   * Query audit log entries (for API)
   */
  query(options = {}) {
    const { type, limit = 100, offset = 0, since, until, clientId, username } = options;
    try {
      // Read from current log file
      const data = fs.readFileSync(this.logFile, 'utf8');
      const lines = data.trim().split('\n').filter(Boolean);
      let entries = lines.map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);

      // Apply filters
      if (type) entries = entries.filter(e => e.type === type);
      if (since) entries = entries.filter(e => new Date(e.timestamp) >= new Date(since));
      if (until) entries = entries.filter(e => new Date(e.timestamp) <= new Date(until));
      if (clientId) entries = entries.filter(e => e.clientId === clientId);
      if (username) entries = entries.filter(e => e.username === username);

      // Sort by timestamp descending
      entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Paginate
      const total = entries.length;
      entries = entries.slice(offset, offset + limit);

      return { entries, total, offset, limit };
    } catch (err) {
      return { entries: [], total: 0, offset, limit, error: err.message };
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