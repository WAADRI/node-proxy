// =============================================================================
// ClientManager - Manages client connections with health checks
// v2.1 - Integrated with circuit breaker, router, bandwidth, storage, metrics
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; Node 24 type
// stripping runs it via require('./lib/client-manager.ts').
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import type { ServerResponse } from 'http';
import type { Socket } from 'net';
import type { WebSocket } from 'ws';
import type { ServerConfig } from './config.ts';
import type { AppLogger } from './logger.ts';
import type { StreamMux, MuxStreamLike } from './stream-mux.ts';
import type { RoutingStrategy } from './router.ts';

// --- External modules injected by server.js (duck-typed minimal contracts) ---

export interface ClientMeta {
  tags?: string[];
  weight?: number;
  bandwidth_limit?: number;
  alias?: string | null;
  notes?: string | null;
  region?: string | null;
  group?: string | null;
}

interface RouterLike {
  strategy?: string;
  select(clients: ClientNode[], cb: unknown, tag?: string | null, strategy?: RoutingStrategy | null): ClientNode | null;
  setStrategy(strategy: string): boolean;
  setWeight(id: string, weight: number): void;
  recordResponseTime(id: string | null | undefined, ms: number): void;
}

interface CircuitBreakerLike {
  isAllowed(id: string): boolean;
  getStatus(id: string): { state?: string; failures?: number; lastFailureType?: string; failureTypes?: Record<string, number> } | null;
  getState(id: string): string;
  getAllStatuses(): Record<string, Record<string, unknown>>;
  onFailure(id: string, type?: string): void;
  onSuccess(id: string): void;
  reset(id: string): void;
  cleanup(ids: Iterable<string>): void;
}

interface BandwidthLimiterLike {
  enabled: boolean;
  check(clientId: string, bytes: number): boolean;
  setLimit(id: string, rate: number): void;
  getUtilization(id: string): number | undefined;
  getStats(): unknown;
}

interface StorageLike {
  logClientEvent(id: string, event: string, data?: Record<string, unknown>): void;
  getClientMetadata(id: string): ClientMeta | null;
  setClientMetadata(id: string, meta: Record<string, unknown>): void;
  recordTraffic(id: string | null | undefined, sent: number, received: number, requests?: number): void;
  getClientEvents(id: string, limit?: number): Record<string, unknown>[];
  getTrafficStats(id: string, since?: number): { bytesSent: number; bytesReceived: number; requests: number };
  getTrafficDaily(id: string | null | undefined, days?: number): { date: string; bytesSent: number; bytesReceived: number }[];
  getTrafficTotals(): { bytesSent: number; bytesReceived: number };
  setConfigOverride(key: string, value: unknown): void;
  getConfigOverride(key: string): unknown;
  getAllOverrides(): Record<string, unknown>;
  deleteConfigOverride(key: string): void;
}

interface MetricsLike {
  activeClients: { set(value: number): void };
  recordRequest(type: string, status: number, durationMs: number): void;
  recordTunnel(result: string): void;
  recordBytes(dir: string, clientId: string | null | undefined, bytes: number): void;
  recordError(type: string, clientId?: string | null): void;
  updateGauges(cm: unknown): void;
  updateCircuitBreakerGauge(id: string, state: string): void;
}

export interface ClientInfo {
  clientId?: string;
  hostname?: string;
  region?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface PendingRecord {
  timeout: NodeJS.Timeout | null;
  reject?: ((err: Error) => void) | null;
  resolve?: ((value: unknown) => void) | null;
  res?: ServerResponse;
  socket?: Socket;
  type?: string;
  // Tunnel/request bookkeeping filled by the proxy modules:
  startTime?: number;
  ip?: string;
  host?: string;
  port?: number;
  head?: Buffer;
  client?: ClientNode | null;
  clientId?: string | null;
  ready?: boolean;
  // mux stream reserved for a socks5 tunnel (openTunnel path)
  stream?: MuxStreamLike | null;
  _onResponse?: (headers: Record<string, unknown>, body?: Buffer) => void;
  _audit?: Record<string, unknown>;
  _touchIdle?: (() => void) | null;
  _idleTimer?: ReturnType<typeof setTimeout> | null;
}

export interface ClientStatsEntry {
  requestsHandled: number;
  tunnelsHandled: number;
  bytesSent: number;
  bytesReceived: number;
  errors: number;
  responseTimeSum: number;
  responseTimeCount: number;
}

export interface ClientNode {
  id: string;
  ws: WebSocket;
  info: ClientInfo;
  tags: string[];
  // Node group (issue #53): one group per node; the group name doubles as an
  // implicit tag for routing. Server-managed, stored in client_metadata.
  group?: string | null;
  connectedAt: number;
  lastSeen: number;
  lastPing: number;
  pingFailures: number;
  pendingRequests: Set<string>;
  // key can be a numeric mux stream id (SOCKS5 mux path) or a uuid string
  // (legacy JSON tunnels and HTTP requests)
  pendingTunnels: Set<string | number>;
  stats: ClientStatsEntry;
  lastActivity: number;
  alias?: string | null;
  notes?: string | null;
  region?: string | null;
  // Attached by the WebSocket layer (mux per protocol capability, RTT from
  // StreamMux ping).
  mux?: StreamMux | null;
  rtt?: number;
}

interface ManagerStats {
  totalRequests: number;
  totalTunnels: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  failedRequests: number;
  startTime: number;
}

type ChangeListener = () => void;

// Effective routing identity of a node (issue #53): explicit tags plus the
// group name, which always doubles as an implicit tag. Used for tag-based
// routing, tag lookups and the /tags endpoint so group membership and tags
// behave uniformly at selection time.
export function clientEffectiveTags(client: { tags?: string[]; group?: string | null }): string[] {
  const out = new Set<string>();
  for (const t of client.tags || []) {
    if (t) out.add(t);
  }
  if (client.group) out.add(client.group);
  return Array.from(out);
}

interface UdpAssociation {
  udpServer: import('dgram').Socket;
  udpClients: Map<string, unknown>;
  socket: unknown;
}

export class ClientManager {
  config: ServerConfig;
  log: AppLogger;
  clients: Map<string, ClientNode> = new Map();
  pendingRequests: Map<string, PendingRecord> = new Map();
  pendingTunnels: Map<string | number, PendingRecord> = new Map();
  private _onChangeListeners: Set<ChangeListener> = new Set();
  private _healthTimer: ReturnType<typeof setInterval> | null = null;

  // External modules (set by server.js)
  circuitBreaker: CircuitBreakerLike | null = null;
  router: RouterLike | null = null;
  bandwidthLimiter: BandwidthLimiterLike | null = null;
  storage: StorageLike | null = null;
  metrics: MetricsLike | null = null;
  // Optional cross-cutting modules attached by server.js / proxy handlers:
  audit?: { logRequest(entry: Record<string, unknown>): void };
  netTest?: {
    onClientProgress(clientId: string | null, msg: Record<string, unknown>): void;
    onClientDone(clientId: string | null, msg: Record<string, unknown>): void;
    start(type: string, targets: unknown, options: Record<string, unknown>, meta?: Record<string, unknown>): string;
    get(id: string): unknown;
  };
  onUdpData?: (msg: Record<string, unknown>) => void;
  requestLog?: {
    record(entry: Record<string, unknown>): void;
    getRecent(limit: number): Record<string, unknown>[];
  };
  // ACL hook (set by server.js to the ACLManager)
  acl?: {
    check(client: ClientNode | null, targetHost: string, protocol: string, targetPort?: number, sourceIp?: string): boolean;
  } | null;
  // Plugin hooks reached through the manager (SOCKS5 tunnel path)
  pluginManager?: { executeHook(hook: string, context: Record<string, unknown>): unknown } | null;
  // UDP ASSOCIATE relays registered by the SOCKS5 server (id -> relay state)
  udpAssociations?: Map<string, UdpAssociation>;

  // Stats
  stats: ManagerStats = {
    totalRequests: 0,
    totalTunnels: 0,
    totalBytesSent: 0,
    totalBytesReceived: 0,
    failedRequests: 0,
    startTime: Date.now(),
  };

  constructor(config: ServerConfig, logger: AppLogger) {
    this.config = config;
    this.log = logger;
  }

  onChange(cb: ChangeListener) {
    if (typeof cb === 'function') {
      this._onChangeListeners.add(cb);
    }
  }

  removeOnChange(cb: ChangeListener) {
    this._onChangeListeners.delete(cb);
  }

  // Public: the web panel notifies listeners after direct mutations (tags etc.)
  _notify() {
    for (const cb of this._onChangeListeners) {
      try {
        cb();
      } catch (_) {
        // listener errors must not break notification
      }
    }
  }

  add(ws: WebSocket, info?: ClientInfo): string {
    // Reuse the client-provided stable ID if present (persisted metadata key)
    const id = info?.clientId || uuidv4();

    // If a client with the same stable ID is already connected (e.g. multi-instance on one host),
    // replace the old connection so the clients map stays consistent.
    const existing = this.clients.get(id);
    if (existing && existing.ws && existing.ws !== ws) {
      try {
        existing.ws.close(4000, 'Replaced by new connection');
      } catch (_) {
        // ignore
      }
      this.remove(id, 'replaced');
    }
    const client: ClientNode = {
      id,
      ws,
      info: info || {},
      tags: info?.tags || [],
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      lastPing: Date.now(),
      pingFailures: 0,
      pendingRequests: new Set(),
      pendingTunnels: new Set(),
      stats: {
        requestsHandled: 0,
        tunnelsHandled: 0,
        bytesSent: 0,
        bytesReceived: 0,
        errors: 0,
        responseTimeSum: 0,
        responseTimeCount: 0,
      },
      lastActivity: Date.now(),
    };
    this.clients.set(id, client);
    this.log.info({ clientId: id, tags: client.tags, info: client.info }, 'Client connected');

    // Persist connection event
    if (this.storage) {
      this.storage.logClientEvent(id, 'connected', { hostname: info?.hostname, tags: client.tags });
      // Load persisted metadata (tags, weight, bandwidth, alias, notes, region, group)
      const meta = this.storage.getClientMetadata(id);
      if (meta) {
        // Server-managed tags are authoritative once a non-empty set has been
        // persisted (issue #53): do not re-merge client-reported tags, so
        // operator changes survive client reconnects.
        if (meta.tags && meta.tags.length > 0) {
          client.tags = [...new Set(meta.tags)];
        }
        if (meta.group != null) client.group = meta.group || null;
        if (meta.weight) this.router?.setWeight(id, meta.weight);
        if (meta.bandwidth_limit) this.bandwidthLimiter?.setLimit(id, meta.bandwidth_limit);
        if (meta.alias) client.alias = meta.alias;
        if (meta.notes) client.notes = meta.notes;
        if (meta.region) client.region = meta.region;
      }
    }

    // Metrics
    if (this.metrics) this.metrics.activeClients.set(this.clients.size);

    this._notify();
    return id;
  }

  remove(id: string, reason = 'unknown') {
    const client = this.clients.get(id);
    if (!client) return;

    this.log.info({ clientId: id, reason }, 'Client disconnected');

    // Storage
    if (this.storage) {
      this.storage.logClientEvent(id, 'disconnected', { reason });
      this.storage.recordTraffic(id, client.stats.bytesSent, client.stats.bytesReceived, client.stats.requestsHandled);
    }

    // Reject pending requests
    for (const reqId of client.pendingRequests) {
      const p = this.pendingRequests.get(reqId);
      if (p) {
        if (p.timeout) clearTimeout(p.timeout);
      if (p.reject) p.reject(new Error('Client disconnected'));
        if (p.res && !p.res.headersSent) {
          try {
            p.res.writeHead(502);
            p.res.end('Client disconnected');
          } catch (_) {
            // ignore
          }
        }
        this.pendingRequests.delete(reqId);
        this.stats.failedRequests++;
        this.metrics?.recordError('disconnect', id);
      }
    }

    // Clean up pending tunnels
    for (const tunId of client.pendingTunnels) {
      const p = this.pendingTunnels.get(tunId);
      if (p) {
        if (p.timeout) clearTimeout(p.timeout);
        if (p.socket && !p.socket.destroyed) {
          try {
            if (p.type === 'socks5') p.socket.write(encodeSocks5Reply(0x03));
            p.socket.end();
          } catch (_) {
            // ignore
          }
        }
        this.pendingTunnels.delete(tunId);
      }
    }

    this.clients.delete(id);
    this.metrics?.activeClients.set(this.clients.size);
    this._notify();
  }

  // ===========================================================================
  // Client Metadata Setters
  // ===========================================================================
  setAlias(id: string, alias: string | null | undefined) {
    const client = this.clients.get(id);
    if (!client) return;
    client.alias = alias || null;
    this._notify();
  }

  setNotes(id: string, notes: string | null | undefined) {
    const client = this.clients.get(id);
    if (!client) return;
    client.notes = notes || null;
    this._notify();
  }

  setRegion(id: string, region: string | null | undefined) {
    const client = this.clients.get(id);
    if (!client) return;
    client.region = region || null;
    this._notify();
  }

  // ===========================================================================
  // Group / Tags (issue #53)
  // Group name doubles as an implicit routing tag, so a node must never carry
  // a tag equal to its own group name (would make routing ambiguous). Both
  // setters validate that constraint and return a result object instead of
  // throwing, so HTTP handlers can map failures to 400s.
  // ===========================================================================
  setGroup(id: string, groupRaw: unknown): { ok: boolean; error?: string; group?: string | null } {
    const client = this.clients.get(id);
    if (!client) return { ok: false, error: 'Client not found' };
    const trimmed = typeof groupRaw === 'string' ? groupRaw.trim() : '';
    const group = trimmed === '' ? null : trimmed;
    if (group) {
      const lower = group.toLowerCase();
      const clash = (client.tags || []).some((t) => t.toLowerCase() === lower);
      if (clash) {
        return { ok: false, error: `Group name "${group}" clashes with an existing tag on this node` };
      }
    }
    client.group = group;
    this._notify();
    return { ok: true, group };
  }

  setTags(id: string, tagsRaw: unknown): { ok: boolean; error?: string; tags?: string[] } {
    const client = this.clients.get(id);
    if (!client) return { ok: false, error: 'Client not found' };
    if (!Array.isArray(tagsRaw)) return { ok: false, error: 'Tags must be an array' };
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const item of tagsRaw) {
      const t = String(item).trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
    }
    if (client.group) {
      const lower = client.group.toLowerCase();
      if (tags.some((t) => t.toLowerCase() === lower)) {
        return { ok: false, error: `Tag "${client.group}" clashes with this node's group name` };
      }
    }
    client.tags = tags;
    this._notify();
    return { ok: true, tags };
  }

  // ===========================================================================
  // Client Selection (delegates to Router)
  // ===========================================================================
  // opts.clientId forces a specific node (UUID password routing, issue #53):
  // returns null when that node is offline or circuit-broken. opts.strategy
  // overrides the global routing strategy for this request.
  selectClient(
    tag?: string | null,
    opts?: { clientId?: string | null; strategy?: RoutingStrategy | null }
  ): ClientNode | null {
    const clients = Array.from(this.clients.values());
    if (clients.length === 0) return null;

    if (opts?.clientId) {
      const forced = this.clients.get(opts.clientId);
      if (!forced) return null;
      if (this.circuitBreaker && !this.circuitBreaker.isAllowed(forced.id)) return null;
      return forced;
    }

    if (this.router) {
      return this.router.select(clients, this.circuitBreaker, tag, opts?.strategy || null);
    }

    // Fallback to random with circuit breaker check
    const candidates = clients.filter((c) => {
      return !this.circuitBreaker || this.circuitBreaker.isAllowed(c.id);
    });
    if (candidates.length === 0) return null;
    if (tag) {
      const tagLower = tag.toLowerCase();
      const tagged = candidates.filter((c) => clientEffectiveTags(c).some((t) => t.toLowerCase() === tagLower));
      if (tagged.length > 0) return tagged[Math.floor(Math.random() * tagged.length)];
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  getRandom(): ClientNode | null {
    return this.selectClient(null);
  }

  getById(id: string): ClientNode | null {
    return this.clients.get(id) || null;
  }

  getAll(): ClientNode[] {
    return Array.from(this.clients.values());
  }

  getByTag(tag: string): ClientNode[] {
    const tagLower = tag.toLowerCase();
    return this.getAll().filter((c) => clientEffectiveTags(c).some((t) => t.toLowerCase() === tagLower));
  }

  getAllTags(): string[] {
    const tags = new Set<string>();
    for (const c of this.clients.values()) {
      for (const t of clientEffectiveTags(c)) tags.add(t);
    }
    return Array.from(tags).sort();
  }

  getAllGroups(): string[] {
    const groups = new Set<string>();
    for (const c of this.clients.values()) {
      if (c.group) groups.add(c.group);
    }
    return Array.from(groups).sort();
  }

  // ===========================================================================
  // Stats
  // ===========================================================================
  getStats() {
    const now = Date.now();
    return {
      total: this.clients.size,
      clients: this.getAll().map((c) => ({
        id: c.id,
        info: c.info,
        tags: c.tags,
        group: c.group || null,
        alias: c.alias || null,
        notes: c.notes || null,
        region: c.region || c.info?.region || null,
        connectedAt: c.connectedAt,
        lastSeen: c.lastSeen,
        lastPing: c.lastPing,
        pingFailures: c.pingFailures,
        pendingRequestsCount: c.pendingRequests.size,
        pendingTunnelsCount: c.pendingTunnels.size,
        clientStats: c.stats,
        circuitBreaker: this.circuitBreaker?.getStatus(c.id) || { state: 'closed' },
        avgResponseTime: c.stats.responseTimeCount > 0
          ? Math.round(c.stats.responseTimeSum / c.stats.responseTimeCount)
          : 0,
        bandwidthUtilization: this.bandwidthLimiter?.getUtilization(c.id) || 0,
      })),
      server: {
        startTime: this.stats.startTime,
        uptime: Math.floor((now - this.stats.startTime) / 1000),
        totalRequests: this.stats.totalRequests,
        totalTunnels: this.stats.totalTunnels,
        totalBytesSent: this.stats.totalBytesSent,
        totalBytesReceived: this.stats.totalBytesReceived,
        failedRequests: this.stats.failedRequests,
        pendingRequests: this.pendingRequests.size,
        pendingTunnels: this.pendingTunnels.size,
      },
      routing: {
        strategy: this.router?.strategy || 'random',
        availableStrategies: ['random', 'least-loaded', 'fastest-response', 'weighted'],
      },
      tags: this.getAllTags(),
      groups: this.getAllGroups(),
      circuitBreaker: {
        enabled: !!this.circuitBreaker,
        config: this.config.circuit_breaker || {},
      },
      bandwidth: {
        enabled: this.bandwidthLimiter?.enabled || false,
        stats: this.bandwidthLimiter?.getStats() || {},
      },
    };
  }

  // ===========================================================================
  // Health Check System
  // ===========================================================================
  startHealthChecks() {
    const hc = this.config.health_check;
    if (!hc || !hc.ping_interval) return;

    this._healthTimer = setInterval(() => {
      this._performHealthCheck();
      // Periodic cleanup of stale circuit breaker entries
      if (this.circuitBreaker) {
        this.circuitBreaker.cleanup(this.clients.keys());
      }
      // Periodic metrics update
      if (this.metrics) {
        this.metrics.updateGauges(this);
      }
    }, hc.ping_interval);

    this.log.info({ interval: hc.ping_interval }, 'Health checks started');
  }

  stopHealthChecks() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  private _performHealthCheck() {
    const hc = this.config.health_check;
    const now = Date.now();

    for (const [id, client] of this.clients) {
      const elapsed = now - client.lastPing;
      if (elapsed > hc.ping_interval + hc.ping_timeout) {
        client.pingFailures++;
        this.storage?.logClientEvent(id, 'ping_failure', { failures: client.pingFailures, elapsed });

        if (client.pingFailures >= hc.max_failures) {
          this.log.warn({ clientId: id, failures: client.pingFailures, elapsed }, 'Client removed due to health check failure');
          try {
            client.ws.close(4001, 'Health check timeout');
          } catch (_) {
            // ignore
          }
          this.remove(id, 'health_check_timeout');
          continue;
        }
        try {
          if (client.ws.readyState === 1) {
            client.ws.ping();
            client.lastPing = now;
          }
        } catch (_) {
          this.remove(id, 'ping_failed');
        }
      }
    }
  }

  recordPong(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastPing = Date.now();
      client.lastSeen = Date.now();
      client.pingFailures = 0;
    }
  }

  // ===========================================================================
  // Stats Tracking
  // ===========================================================================
  trackRequest(type: string, status: number, durationMs: number, clientId?: string | null) {
    this.stats.totalRequests++;
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (client) {
      client.stats.requestsHandled++;
      client.lastActivity = Date.now();
      if (durationMs > 0) {
        client.stats.responseTimeSum += durationMs;
        client.stats.responseTimeCount++;
      }
    }
    this.metrics?.recordRequest(type, status, durationMs || 0);
    this.router?.recordResponseTime(clientId || null, durationMs || 0);
  }

  trackTunnel(clientId?: string | null) {
    this.stats.totalTunnels++;
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (client) {
      client.stats.tunnelsHandled++;
      client.lastActivity = Date.now();
    }
    this.metrics?.recordTunnel('success');
  }

  trackBytes(clientId: string | null | undefined, sent: number, received: number) {
    this.stats.totalBytesSent += sent;
    this.stats.totalBytesReceived += received;
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (client) {
      client.stats.bytesSent += sent;
      client.stats.bytesReceived += received;
    }
    this.metrics?.recordBytes('sent', clientId, sent);
    this.metrics?.recordBytes('received', clientId, received);
    this.storage?.recordTraffic(clientId, sent, received);
  }

  trackError(clientId?: string | null, type = 'request') {
    this.stats.failedRequests++;
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (client) client.stats.errors++;
    this.metrics?.recordError(type, clientId);

    // Circuit breaker: record failure (classified by type for observability)
    if (this.circuitBreaker && clientId) {
      this.circuitBreaker.onFailure(clientId, type);
      if (this.metrics) {
        this.metrics.updateCircuitBreakerGauge(clientId, this.circuitBreaker.getState(clientId));
      }
    }
  }

  trackSuccess(clientId?: string | null) {
    if (this.circuitBreaker && clientId) {
      this.circuitBreaker.onSuccess(clientId);
      if (this.metrics) {
        this.metrics.updateCircuitBreakerGauge(clientId, this.circuitBreaker.getState(clientId));
      }
    }
  }
}

function encodeSocks5Reply(replyCode: number): Buffer {
  const buf = Buffer.alloc(10);
  buf[0] = 0x05;
  buf[1] = replyCode;
  buf[2] = 0x00;
  buf[3] = 0x01;
  for (let i = 4; i < 10; i++) buf[i] = 0x00;
  return buf;
}
