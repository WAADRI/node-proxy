// =============================================================================
// Storage - Persistent storage using SQLite (sql.js - pure JS/WASM)
// Migrated to TypeScript (issue #42, Phase 2).
//
// NOTE: CJS-style TS on purpose - sql.js is loaded inside try/catch (storage
// degrades gracefully when the optional dependency is missing) and __dirname
// resolves the default data directory. Node type stripping loads this file as
// CommonJS; callers use require('./lib/storage.ts').
// =============================================================================

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const path = require('path');
const fs = require('fs');

let initSqlJs: ((config?: Record<string, unknown>) => Promise<SqlJsStaticLike>) | null = null;
try {
  initSqlJs = require('sql.js');
} catch (_) {
  // optional dependency missing - storage disabled gracefully
}

// Structural view over the sql.js API surface this module uses (the package
// ships @types/sql.js; the alias keeps the import above optional-safe).
type SqlJsDatabaseLike = {
  run(sql: string, params?: (string | number | null | Uint8Array)[]): unknown;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): SqlJsStatementLike;
  export(): Uint8Array;
  close(): void;
};
type SqlJsStatementLike = {
  bind(params: (string | number | null | Uint8Array)[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
};
type SqlJsStaticLike = {
  Database: new (data?: Uint8Array | null) => SqlJsDatabaseLike;
};

export interface TrafficTotals {
  bytesSent: number;
  bytesReceived: number;
}

export interface TrafficSummary extends TrafficTotals {
  requests: number;
}

export interface TrafficDay extends TrafficTotals {
  date: string;
}

export interface ClientMetaRow {
  client_id: string;
  tags: string[];
  alias: string | null;
  notes: string | null;
  weight: number;
  bandwidth_limit: number | null;
  region?: string;
  // Node group (issue #53): the group name doubles as an implicit tag for
  // routing. Stored in the `grp` column (SQLite keyword safety).
  group?: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

export interface ClientMetadataUpdate {
  tags?: string[];
  alias?: string | null;
  notes?: string | null;
  weight?: number | null;
  bandwidth_limit?: number | null;
  region?: string | null;
  group?: string | null;
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

class Storage {
  config: Record<string, unknown>;
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown> | string, msg?: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  db: SqlJsDatabaseLike | null = null;
  available = false;
  private dbPath: string | null = null;
  private _saveTimer: ReturnType<typeof setInterval> | null = null;
  private _dirty = false;
  ready?: Promise<void>;

  constructor(config: Record<string, unknown>, logger: Storage['log']) {
    this.config = config;
    this.log = logger;

    const storageSection = config.storage as { path?: string } | undefined;
    const dbPath = storageSection?.path || path.join(__dirname, '..', 'data', 'node-proxy.db');
    const dbDir = path.dirname(dbPath);

    if (!initSqlJs) {
      this.log.warn('sql.js not available, storage disabled. Run: npm install sql.js');
      return;
    }

    // Async init; resolves (never rejects) once the sql.js DB is ready.
    // Startup code that needs storage can await this.ready.
    this.ready = this._init(dbPath, dbDir).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ error: message }, 'Failed to initialize sql.js storage');
    });
  }

  private async _init(dbPath: string, dbDir: string) {
    try {
      const SQL = await initSqlJs!();
      fs.mkdirSync(dbDir, { recursive: true });

      // Try to load existing database
      if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        this.db = new SQL.Database(buffer);
      } else {
        this.db = new SQL.Database();
      }

      this.db.run('PRAGMA journal_mode = DELETE');
      this._initSchema();
      this.available = true;
      this.dbPath = dbPath;

      // Save initial schema
      this._save();

      // Periodic save — exports the in-memory sql.js database to disk at a
      // fixed interval instead of after every N insert/update operations.
      // A counter-based approach (every 100 calls) generates dozens of
      // full-database exports per second on a busy proxy, blocking the event
      // loop and causing Docker health-check timeouts → container restart
      // → on-disk file may be stale/empty → traffic data "disappears".
      this._saveTimer = setInterval(() => {
        if (this._dirty) {
          this._save();
          this._dirty = false;
        }
      }, 30000);

      this.log.info({ path: dbPath }, 'Storage initialized');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ error: message }, 'Failed to initialize SQLite storage');
    }
  }

  private _save() {
    if (!this.db || !this.dbPath) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath + '.tmp', buffer);
      fs.renameSync(this.dbPath + '.tmp', this.dbPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message }, 'Failed to save database');
    }
  }

  private _initSchema() {
    this.db!.run(`
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
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_client_events_client_id ON client_events(client_id)');
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_client_events_created_at ON client_events(created_at)');
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_traffic_stats_client_id ON traffic_stats(client_id)');
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_traffic_stats_period ON traffic_stats(period_start, period_end)');

    // Migration: add region column to client_metadata (v3.1)
    try {
      this.db!.run("ALTER TABLE client_metadata ADD COLUMN region TEXT DEFAULT ''");
    } catch (_) {
      // column may already exist
    }

    // Migration: add group column to client_metadata (issue #53, node groups)
    try {
      this.db!.run("ALTER TABLE client_metadata ADD COLUMN grp TEXT DEFAULT ''");
    } catch (_) {
      // column may already exist
    }
  }

  private _prepare(sql: string): SqlJsStatementLike | null {
    try {
      return this.db!.prepare(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message, sql }, 'SQL prepare error');
      return null;
    }
  }

  // ===========================================================================
  // Client Events
  // ===========================================================================
  logClientEvent(clientId: string, eventType: string, data: Record<string, unknown> = {}) {
    if (!this.available || !this.db) return;
    try {
      this.db.run(
        'INSERT INTO client_events (client_id, event_type, data, created_at) VALUES (?, ?, ?, ?)',
        [clientId, eventType, JSON.stringify(data), Date.now()]
      );
      this._dirty = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message }, 'Failed to log client event');
    }
  }

  getClientEvents(clientId: string, limit = 100): Record<string, unknown>[] {
    if (!this.available || !this.db) return [];
    try {
      const stmt = this._prepare('SELECT * FROM client_events WHERE client_id = ? ORDER BY created_at DESC LIMIT ?');
      if (!stmt) return [];
      stmt.bind([clientId, limit]);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        if (typeof row.data === 'string') {
          try {
            row.data = JSON.parse(row.data);
          } catch (_) {
            row.data = {};
          }
        }
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
  recordTraffic(clientId: string | null | undefined, bytesSent: number, bytesReceived: number, count = 1) {
    if (!this.available || !this.db || !clientId) return;
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
      this._dirty = true;
    } catch (_) {
      // Ignore - best effort
    }
  }

  getTrafficStats(clientId: string, since?: number): TrafficSummary {
    if (!this.available || !this.db) return { bytesSent: 0, bytesReceived: 0, requests: 0 };
    try {
      const result = this.db.exec(
        `SELECT COALESCE(SUM(bytes_sent),0) as bs, COALESCE(SUM(bytes_received),0) as br, COALESCE(SUM(requests_count),0) as rc FROM traffic_stats WHERE client_id = '${clientId.replace(/'/g, "''")}' AND period_start >= ${since || 0}`
      );
      if (result.length > 0 && result[0].values.length > 0) {
        const vals = result[0].values[0];
        return { bytesSent: num(vals[0]), bytesReceived: num(vals[1]), requests: num(vals[2]) };
      }
      return { bytesSent: 0, bytesReceived: 0, requests: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message }, 'getTrafficStats query failed');
      return { bytesSent: 0, bytesReceived: 0, requests: 0 };
    }
  }

  // Aggregate traffic_stats (minute rows) into per-day buckets for the last N
  // days (local timezone). clientId omitted = all clients combined.
  getTrafficDaily(clientId: string | null | undefined, days = 7): TrafficDay[] {
    if (!this.available || !this.db) return [];
    const safeDays = Math.max(1, Math.min(30, Math.floor(days) || 7));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const since = startOfToday - (safeDays - 1) * 86400000;
    try {
      const where = clientId
        ? `WHERE client_id = '${clientId.replace(/'/g, "''")}' AND period_start >= ${since}`
        : `WHERE period_start >= ${since}`;
      const result = this.db.exec(
        `SELECT period_start, bytes_sent, bytes_received FROM traffic_stats ${where}`
      );
      const byDay: Record<string, { bytesSent: number; bytesReceived: number }> = {};
      if (result.length > 0 && result[0].values) {
        for (const row of result[0].values) {
          const d = new Date(num(row[0]));
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (!byDay[key]) byDay[key] = { bytesSent: 0, bytesReceived: 0 };
          byDay[key].bytesSent += num(row[1]);
          byDay[key].bytesReceived += num(row[2]);
        }
      }
      // Fill in every day (including empty ones) oldest -> newest
      const out: TrafficDay[] = [];
      for (let i = safeDays - 1; i >= 0; i--) {
        const d = new Date(startOfToday - i * 86400000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        out.push({
          date: key,
          bytesSent: byDay[key]?.bytesSent || 0,
          bytesReceived: byDay[key]?.bytesReceived || 0,
        });
      }
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message }, 'getTrafficDaily query failed');
      return [];
    }
  }

  // Lifetime totals across all recorded traffic (all clients)
  getTrafficTotals(): TrafficTotals {
    if (!this.available || !this.db) return { bytesSent: 0, bytesReceived: 0 };
    try {
      const result = this.db.exec(
        'SELECT COALESCE(SUM(bytes_sent),0), COALESCE(SUM(bytes_received),0) FROM traffic_stats'
      );
      if (result.length > 0 && result[0].values.length > 0) {
        const vals = result[0].values[0];
        return { bytesSent: num(vals[0]), bytesReceived: num(vals[1]) };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message }, 'getTrafficTotals query failed');
      // fall through
    }
    return { bytesSent: 0, bytesReceived: 0 };
  }

  // ===========================================================================
  // Config Overrides
  // ===========================================================================
  setConfigOverride(key: string, value: unknown) {
    if (!this.available || !this.db) return;
    try {
      this.db.run(
        'INSERT OR REPLACE INTO config_overrides (key, value, updated_at) VALUES (?, ?, ?)',
        [key, JSON.stringify(value), Date.now()]
      );
      this._dirty = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ error: message }, 'Failed to set config override');
    }
  }

  getConfigOverride(key: string): unknown {
    if (!this.available || !this.db) return null;
    try {
      const stmt = this._prepare('SELECT value FROM config_overrides WHERE key = ?');
      if (!stmt) return null;
      stmt.bind([key]);
      let val: unknown = null;
      if (stmt.step()) {
        val = stmt.getAsObject().value;
      }
      stmt.free();
      if (typeof val !== 'string') return null;
      try {
        return JSON.parse(val);
      } catch (_) {
        return val;
      }
    } catch (_) {
      return null;
    }
  }

  getAllOverrides(): Record<string, unknown> {
    if (!this.available || !this.db) return {};
    try {
      const result = this.db.exec('SELECT key, value FROM config_overrides');
      const obj: Record<string, unknown> = {};
      for (const r of result) {
        for (const row of r.values) {
          const raw = row[1];
          if (typeof raw === 'string') {
            try {
              obj[String(row[0])] = JSON.parse(raw);
            } catch (_) {
              obj[String(row[0])] = raw;
            }
          }
        }
      }
      return obj;
    } catch (_) {
      return {};
    }
  }

  deleteConfigOverride(key: string) {
    if (!this.available || !this.db) return;
    try {
      this.db.run('DELETE FROM config_overrides WHERE key = ?', [key]);
      this._save();
    } catch (_) {
      // ignore
    }
  }

  // ===========================================================================
  // Client Metadata
  // ===========================================================================
  setClientMetadata(clientId: string, meta: ClientMetadataUpdate) {
    if (!this.available || !this.db) return;
    try {
      const now = Date.now();
      // Merge with existing row so partial updates (tags only, weight only, ...)
      // don't reset other fields to defaults (INSERT OR REPLACE replaces the whole row).
      const existing = this.getClientMetadata(clientId) || ({} as Partial<ClientMetaRow>);
      const tags = Array.isArray(meta.tags) ? meta.tags : (existing.tags || []);
      const weight = meta.weight != null ? meta.weight : (existing.weight != null ? existing.weight : 1.0);
      const bandwidthLimit =
        meta.bandwidth_limit != null
          ? meta.bandwidth_limit
          : existing.bandwidth_limit != null
            ? existing.bandwidth_limit
            : null;
      const region = meta.region != null ? meta.region : (existing.region != null ? existing.region : '');
      const group = meta.group != null ? (meta.group || '') : (existing.group != null ? existing.group : '');
      const createdAt = existing.created_at || now;

      this.db.run(
        `INSERT OR REPLACE INTO client_metadata (client_id, tags, alias, notes, weight, bandwidth_limit, region, grp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clientId,
          JSON.stringify(tags),
          meta.alias || existing.alias || null,
          meta.notes || existing.notes || null,
          weight,
          bandwidthLimit,
          region,
          group,
          createdAt,
          now,
        ]
      );
      this._save();
    } catch (_) {
      // ignore
    }
  }

  getClientMetadata(clientId: string): ClientMetaRow | null {
    if (!this.available || !this.db) return null;
    try {
      const stmt = this._prepare('SELECT * FROM client_metadata WHERE client_id = ?');
      if (!stmt) return null;
      stmt.bind([clientId]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        const parsed: ClientMetaRow = {
          client_id: String(row.client_id || clientId),
          tags: parseJsonArray(row.tags),
          alias: row.alias != null ? String(row.alias) : null,
          notes: row.notes != null ? String(row.notes) : null,
          weight: num(row.weight),
          bandwidth_limit: row.bandwidth_limit != null ? num(row.bandwidth_limit) : null,
          region: row.region != null ? String(row.region) : undefined,
          group: row.grp != null && String(row.grp) !== '' ? String(row.grp) : null,
          created_at: num(row.created_at),
          updated_at: num(row.updated_at),
        };
        return parsed;
      }
      stmt.free();
      return null;
    } catch (_) {
      return null;
    }
  }

  getAllClientMetadata(): Record<string, Partial<ClientMetaRow>> {
    if (!this.available || !this.db) return {};
    try {
      const result = this.db.exec('SELECT * FROM client_metadata');
      const clients: Record<string, Partial<ClientMetaRow>> = {};
      for (const r of result) {
        for (const row of r.values) {
          const c: Partial<ClientMetaRow> = {
            client_id: String(row[0]),
            tags: [],
            alias: row[2] != null ? String(row[2]) : null,
            notes: row[3] != null ? String(row[3]) : null,
            weight: num(row[4]),
            bandwidth_limit: row[5] != null ? num(row[5]) : null,
            region: row[8] != null && String(row[8]) !== '' ? String(row[8]) : undefined,
            group: row[9] != null && String(row[9]) !== '' ? String(row[9]) : null,
            created_at: num(row[6]),
            updated_at: num(row[7]),
          };
          c.tags = parseJsonArray(row[1]);
          clients[c.client_id!] = c;
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
    } catch (_) {
      // ignore
    }
  }

  close() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    if (this.db) {
      try {
        this._save();
        this.db.close();
      } catch (_) {
        // ignore
      }
      this.db = null;
    }
  }
}

module.exports = { Storage };
