// =============================================================================
// Storage - Persistent storage using SQLite (sql.js - pure JS/WASM)
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');

let initSqlJs = null;
try {
  initSqlJs = require('sql.js');
} catch (_) {}

class Storage {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.db = null;
    this.available = false;

    const dbPath = config.storage?.path || path.join(__dirname, '..', 'data', 'node-proxy.db');
    const dbDir = path.dirname(dbPath);

    if (!initSqlJs) {
      this.log.warn('sql.js not available, storage disabled. Run: npm install sql.js');
      return;
    }

    this._init(dbPath, dbDir).catch(err => {
      this.log.warn({ error: err.message }, 'Failed to initialize sql.js storage');
    });
  }

  async _init(dbPath, dbDir) {
    try {
      const SQL = await initSqlJs();
      fs.mkdirSync(dbDir, { recursive: true });

      // Try to load existing database
      if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        this.db = new SQL.Database(buffer);
      } else {
        this.db = new SQL.Database();
      }

      this.db.run('PRAGMA journal_mode = WAL');
      this._initSchema();
      this.available = true;
      this.dbPath = dbPath;

      // Save initial schema
      this._save();

      this.log.info({ path: dbPath }, 'Storage initialized');
    } catch (err) {
      this.log.warn({ error: err.message }, 'Failed to initialize SQLite storage');
    }
  }

  _save() {
    if (!this.db || !this.dbPath) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath + '.tmp', buffer);
      fs.renameSync(this.dbPath + '.tmp', this.dbPath);
    } catch (err) {
      this.log.error({ error: err.message }, 'Failed to save database');
    }
  }

  _initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS client_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        data TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS traffic_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        bytes_sent INTEGER DEFAULT 0,
        bytes_received INTEGER DEFAULT 0,
        requests_count INTEGER DEFAULT 0,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_overrides (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS client_metadata (
        client_id TEXT PRIMARY KEY,
        tags TEXT,
        alias TEXT,
        notes TEXT,
        weight REAL DEFAULT 1.0,
        bandwidth_limit INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_client_events_client_id ON client_events(client_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_client_events_created_at ON client_events(created_at)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_traffic_stats_client_id ON traffic_stats(client_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_traffic_stats_period ON traffic_stats(period_start, period_end)');
  }

  _prepare(sql) {
    try {
      return this.db.prepare(sql);
    } catch (err) {
      this.log.error({ error: err.message, sql }, 'SQL prepare error');
      return null;
    }
  }

  // ===========================================================================
  // Client Events
  // ===========================================================================
  logClientEvent(clientId, eventType, data = {}) {
    if (!this.available || !this.db) return;
    try {
      this.db.run(
        'INSERT INTO client_events (client_id, event_type, data, created_at) VALUES (?, ?, ?, ?)',
        [clientId, eventType, JSON.stringify(data), Date.now()]
      );
      this._save();
    } catch (err) {
      this.log.error({ error: err.message }, 'Failed to log client event');
    }
  }

  getClientEvents(clientId, limit = 100) {
    if (!this.available || !this.db) return [];
    try {
      const stmt = this._prepare('SELECT * FROM client_events WHERE client_id = ? ORDER BY created_at DESC LIMIT ?');
      if (!stmt) return [];
      stmt.bind([clientId, limit]);
      const rows = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        try { row.data = JSON.parse(row.data || '{}'); } catch (_) { row.data = {}; }
        rows.push(row);
      }
      stmt.free();
      return rows;
    } catch (_) {
      return [];
    }
  }

  // ===========================================================================
  // Traffic Stats
  // ===========================================================================
  recordTraffic(clientId, bytesSent, bytesReceived, count = 1) {
    if (!this.available || !this.db) return;
    try {
      const now = Date.now();
      const periodStart = Math.floor(now / 60000) * 60000;

      // Check if row exists
      const existing = this.db.exec(
        `SELECT id FROM traffic_stats WHERE client_id = '${clientId.replace(/'/g, "''")}' AND period_start = ${periodStart}`
      );
      if (existing.length > 0 && existing[0].values.length > 0) {
        this.db.run(
          `UPDATE traffic_stats SET bytes_sent = bytes_sent + ?, bytes_received = bytes_received + ?, requests_count = requests_count + ? WHERE client_id = ? AND period_start = ?`,
          [bytesSent, bytesReceived, count, clientId, periodStart]
        );
      } else {
        this.db.run(
          `INSERT INTO traffic_stats (client_id, bytes_sent, bytes_received, requests_count, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?)`,
          [clientId, bytesSent, bytesReceived, count, periodStart, periodStart + 60000]
        );
      }
      // Save periodically (every 100 records)
      this._saveCounter = (this._saveCounter || 0) + 1;
      if (this._saveCounter % 100 === 0) this._save();
    } catch (err) {
      // Ignore - best effort
    }
  }

  getTrafficStats(clientId, since) {
    if (!this.available || !this.db) return { bytesSent: 0, bytesReceived: 0, requests: 0 };
    try {
      const result = this.db.exec(
        `SELECT COALESCE(SUM(bytes_sent),0) as bs, COALESCE(SUM(bytes_received),0) as br, COALESCE(SUM(requests_count),0) as rc FROM traffic_stats WHERE client_id = '${clientId.replace(/'/g, "''")}' AND period_start >= ${since || 0}`
      );
      if (result.length > 0 && result[0].values.length > 0) {
        const vals = result[0].values[0];
        return { bytesSent: vals[0], bytesReceived: vals[1], requests: vals[2] };
      }
      return { bytesSent: 0, bytesReceived: 0, requests: 0 };
    } catch (_) {
      return { bytesSent: 0, bytesReceived: 0, requests: 0 };
    }
  }

  // ===========================================================================
  // Config Overrides
  // ===========================================================================
  setConfigOverride(key, value) {
    if (!this.available || !this.db) return;
    try {
      this.db.run(
        'INSERT OR REPLACE INTO config_overrides (key, value, updated_at) VALUES (?, ?, ?)',
        [key, JSON.stringify(value), Date.now()]
      );
      this._save();
    } catch (_) {}
  }

  getConfigOverride(key) {
    if (!this.available || !this.db) return null;
    try {
      const stmt = this._prepare('SELECT value FROM config_overrides WHERE key = ?');
      if (!stmt) return null;
      stmt.bind([key]);
      if (stmt.step()) {
        const val = stmt.getAsObject().value;
        stmt.free();
        try { return JSON.parse(val); } catch (_) { return val; }
      }
      stmt.free();
      return null;
    } catch (_) {
      return null;
    }
  }

  getAllOverrides() {
    if (!this.available || !this.db) return {};
    try {
      const result = this.db.exec('SELECT key, value FROM config_overrides');
      const obj = {};
      for (const r of result) {
        for (const row of r.values) {
          try { obj[row[0]] = JSON.parse(row[1]); } catch (_) { obj[row[0]] = row[1]; }
        }
      }
      return obj;
    } catch (_) {
      return {};
    }
  }

  deleteConfigOverride(key) {
    if (!this.available || !this.db) return;
    try {
      this.db.run('DELETE FROM config_overrides WHERE key = ?', [key]);
      this._save();
    } catch (_) {}
  }

  // ===========================================================================
  // Client Metadata
  // ===========================================================================
  setClientMetadata(clientId, meta) {
    if (!this.available || !this.db) return;
    try {
      const now = Date.now();
      // Merge with existing row so partial updates (tags only, weight only, ...)
      // don't reset other fields to defaults (INSERT OR REPLACE replaces the whole row).
      const existing = this.getClientMetadata(clientId) || {};
      const tags = Array.isArray(meta.tags) ? meta.tags : (existing.tags || []);
      const weight = meta.weight != null ? meta.weight : (existing.weight != null ? existing.weight : 1.0);
      const bandwidthLimit = meta.bandwidth_limit != null ? meta.bandwidth_limit : (existing.bandwidth_limit != null ? existing.bandwidth_limit : null);
      const createdAt = existing.created_at || now;

      this.db.run(
        `INSERT OR REPLACE INTO client_metadata (client_id, tags, alias, notes, weight, bandwidth_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [clientId, JSON.stringify(tags), meta.alias || existing.alias || null, meta.notes || existing.notes || null, weight, bandwidthLimit, createdAt, now]
      );
      this._save();
    } catch (_) {}
  }

  getClientMetadata(clientId) {
    if (!this.available || !this.db) return null;
    try {
      const stmt = this._prepare('SELECT * FROM client_metadata WHERE client_id = ?');
      if (!stmt) return null;
      stmt.bind([clientId]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        try { row.tags = JSON.parse(row.tags || '[]'); } catch (_) { row.tags = []; }
        return row;
      }
      stmt.free();
      return null;
    } catch (_) {
      return null;
    }
  }

  getAllClientMetadata() {
    if (!this.available || !this.db) return {};
    try {
      const result = this.db.exec('SELECT * FROM client_metadata');
      const clients = {};
      for (const r of result) {
        for (const row of r.values) {
          const c = { client_id: row[0], tags: [], alias: row[2], notes: row[3], weight: row[4], bandwidth_limit: row[5], created_at: row[6], updated_at: row[7] };
          try { c.tags = JSON.parse(row[1] || '[]'); } catch (_) { c.tags = []; }
          clients[c.client_id] = c;
        }
      }
      return clients;
    } catch (_) {
      return {};
    }
  }

  // ===========================================================================
  // Cleanup old data
  // ===========================================================================
  cleanupOldData(retentionDays = 30) {
    if (!this.available || !this.db) return;
    try {
      const cutoff = Date.now() - retentionDays * 86400000;
      this.db.run('DELETE FROM client_events WHERE created_at < ?', [cutoff]);
      this.db.run('DELETE FROM traffic_stats WHERE period_start < ?', [cutoff]);
      this._save();
      this.log.info({ retentionDays }, 'Old data cleaned up');
    } catch (_) {}
  }

  close() {
    if (this.db) {
      try {
        this._save();
        this.db.close();
      } catch (_) {}
      this.db = null;
    }
  }
}

module.exports = { Storage };