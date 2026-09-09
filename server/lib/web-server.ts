// =============================================================================
// Web Server v3.0 - Express app with full Phase 3 API
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose:
// a value-level export function would flip Node's module detection to ESM and
// break require/__dirname, so the file keeps module.exports and refers to
// migrated TS modules only through import()-type queries (stripped, no syntax).
// =============================================================================

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

import type { Request as ExpressRequestT } from 'express';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

type HttpRequest = ExpressRequestT;
type HttpResponse = import('express').Response;
type WebRequest = HttpRequest & { user?: string; role?: string };
type ClientManager = import('./client-manager.ts').ClientManager;
type AuthManager = import('./auth.ts').AuthManager;
type RoleName = import('./auth.ts').RoleName;
type ServerConfig = import('./config.ts').ServerConfig;
type AppLogger = import('./logger.ts').AppLogger;
type MetricsManager = import('./metrics.ts').MetricsManager;
type DomainRouter = import('./domain-router.ts').DomainRouter;
type RequestCache = import('./cache.ts').RequestCache;

// --- Duck types for still-JS modules passed in by server.js ----------------
interface SettingsManagerLike {
  list(): Record<string, unknown>;
  apply(group: string, values: Record<string, unknown>): { ok: boolean; error?: string };
  reset(group: string): { ok: boolean; error?: string };
}
interface AclManagerLike {
  listRules(): unknown[];
  addRule(rule: Record<string, unknown>): boolean;
  removeRule(ruleId: string): boolean;
  getStats(): Record<string, unknown>;
}
interface AuditLoggerLike {
  query(q: Record<string, unknown>): unknown;
  getStats(): Record<string, unknown>;
}
interface AutoUpdaterLike {
  getStatus(): Record<string, unknown>;
  triggerCheck(): void;
}
interface PanelPluginManagerLike {
  list(): unknown[];
  enable(name: string): boolean;
  disable(name: string): boolean;
  reload(name: string): { success: boolean; [key: string]: unknown };
  uninstall(name: string): { success: boolean; [key: string]: unknown };
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}
// express params/query values can be string | string[] depending on @types/express
function pstr(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return '';
}

function createWebServer(
  clientManager: ClientManager,
  authManager: AuthManager,
  config: ServerConfig,
  logger: AppLogger,
  metricsManager: MetricsManager | null,
  domainRouter: DomainRouter | null,
  cache: RequestCache | null,
  pluginManager: PanelPluginManagerLike | null,
  aclManager: AclManagerLike | null,
  auditLogger: AuditLoggerLike | null,
  autoUpdater: AutoUpdaterLike | null,
  settingsManager: SettingsManagerLike | null
) {
  const app = express();

  // Trust the first upstream proxy (nginx) so req.ip reads X-Forwarded-For
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Vue management panel (built from server/web via `npm run build`).
  // Assets are served unauthenticated (like /public); the HTML entry itself
  // is protected by the auth middleware below.
  const webDist = path.join(__dirname, '..', 'web', 'dist');
  const webIndex = path.join(webDist, 'index.html');
  if (fs.existsSync(webIndex)) {
    app.use('/app/assets', express.static(path.join(webDist, 'assets'), { index: false, maxAge: '1h' }));
  }

  // ===========================================================================
  // Auth Routes
  // ===========================================================================
  app.get('/login', (req: WebRequest, res: HttpResponse) => {
    if (!config.auth.web.enabled) {
      res.redirect('/');
      return;
    }
    res.sendFile(path.join(__dirname, '..', 'views', 'login.html'));
  });

  app.post('/api/login', (req: WebRequest, res: HttpResponse) => {
    const { username, password } = (req.body || {}) as { username?: string; password?: string };
    if (authManager.validateWebLogin(asString(username), asString(password))) {
      const token = authManager.generateWebToken(asString(username));
      const role = authManager.getRole(asString(username));
      logger.info({ username, role }, 'Web login success');
      res.json({ success: true, token, role, redirect: '/' });
    } else {
      logger.warn({ username, ip: req.ip }, 'Web login failed');
      res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
  });

  app.post('/api/logout', (_req: WebRequest, res: HttpResponse) => {
    res.json({ success: true });
  });

  app.use(authManager.webAuthMiddleware());

  // ===========================================================================
  // Vue management panel (auth-protected; the single panel entry point)
  // ===========================================================================
  app.get('/', (req: WebRequest, res: HttpResponse) => {
    if (fs.existsSync(webIndex)) {
      res.redirect('/app/');
      return;
    }
    res.status(503).type('text/plain').send('管理面板尚未构建。请在 server/web 目录执行 npm install && npm run build 后重启。');
  });

  if (fs.existsSync(webIndex)) {
    app.get(['/app', '/app/*'], (req: WebRequest, res: HttpResponse) => {
      res.sendFile(webIndex);
    });
  }

  // ===========================================================================
  // Metrics endpoint
  // ===========================================================================
  if (metricsManager) {
    app.get('/metrics', metricsManager.metricsMiddleware());
  }

  // ===========================================================================
  // Swagger / OpenAPI docs
  // ===========================================================================
  const { setupSwagger } = require('./swagger.ts') as { setupSwagger(app: unknown): void };
  setupSwagger(app);

  // ===========================================================================
  // API v1 Routes
  // ===========================================================================
  const api = express.Router();

  // --- Status ---
  api.get('/status', (_req: WebRequest, res: HttpResponse) => {
    res.json(clientManager.getStats());
  });

  // --- Recent request log (for the panel "Request log" view) ---
  api.get('/logs', (req: WebRequest, res: HttpResponse) => {
    const limit = Math.min(parseInt(str(req.query.limit), 10) || 100, 500);
    const hub = clientManager.requestLog;
    if (!hub) {
      res.json({ logs: [] });
      return;
    }
    res.json({ logs: hub.getRecent(limit) });
  });

  // --- Network testing toolkit (issue #31): ping / tcping / http / dns / traceroute ---
  api.get('/network-test/types', (_req: WebRequest, res: HttpResponse) => {
    res.json({
      types: [
        { id: 'ping', label: 'Ping' },
        { id: 'tcping', label: 'Tcping' },
        { id: 'http', label: '请求测速' },
        { id: 'dns', label: 'DNS 查询' },
        { id: 'traceroute', label: '路由追踪' },
      ],
    });
  });

  api.post('/network-test', (req: WebRequest, res: HttpResponse) => {
    const nt = clientManager.netTest;
    if (!nt) {
      res.status(501).json({ success: false, message: 'Network test manager not available' });
      return;
    }
    // clients: undefined -> run on this server; 'all' -> all online nodes;
    //          [clientId...] -> the selected nodes execute the tests (issue #31)
    const body = (req.body || {}) as Record<string, unknown>;
    const type = asString(body.type);
    const targets = body.targets;
    const options = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>;
    const clients = body.clients;
    try {
      const meta = clients !== undefined ? { clients } : {};
      const taskId = nt.start(type, targets, options, meta);
      res.json({ success: true, taskId });
    } catch (err) {
      const e = err as Error & { code?: number };
      res.status(e.code === 400 ? 400 : 500).json({ success: false, message: e.message });
    }
  });

  api.get('/network-test/:id', (req: WebRequest, res: HttpResponse) => {
    const nt = clientManager.netTest;
    if (!nt) {
      res.status(501).json({ success: false, message: 'Network test manager not available' });
      return;
    }
    const task = nt.get(pstr(req.params.id));
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found or expired' });
      return;
    }
    res.json(task);
  });

  api.get('/config', (_req: WebRequest, res: HttpResponse) => {
    const safeConfig = {
      server: config.server,
      auth: { web: { enabled: config.auth.web.enabled }, proxy: { enabled: config.auth.proxy.enabled } },
      logging: { level: config.logging.level },
      health_check: config.health_check,
      client: config.client,
      routing: config.routing || { strategy: 'random' },
      circuit_breaker: config.circuit_breaker || {},
      bandwidth: config.bandwidth || { enabled: false },
      metrics: config.metrics || { enabled: true },
      cache: { enabled: cache?.enabled, default_ttl: cache?.defaultTTL, max_size: cache?.maxSize },
      domain_rules: domainRouter?.listRules() || [],
      acme: { enabled: config.acme?.enabled || false, domains: config.acme?.domains || [] },
    };
    res.json(safeConfig);
  });

  // --- Runtime settings (panel-adjustable parameters) ---
  const SETTINGS_PERM: Record<string, string> = {
    routing: 'routing:strategy',
    circuit_breaker: 'system:config',
    bandwidth: 'system:config',
    client: 'system:config',
    cache: 'system:config',
  };

  function canEditSettings(user: string | undefined, group: string): boolean {
    const perm = SETTINGS_PERM[group];
    if (!perm) return false;
    return authManager.hasPermission(str(user), perm) || authManager.hasPermission(str(user), 'system:config');
  }

  api.get('/settings', (req: WebRequest, res: HttpResponse) => {
    if (!settingsManager) {
      res.status(501).json({ success: false, message: 'Settings manager not available' });
      return;
    }
    const data = settingsManager.list();
    const editable: Record<string, boolean> = {};
    for (const g of Object.keys(SETTINGS_PERM)) editable[g] = canEditSettings(req.user, g);
    res.json({ success: true, ...data, editable });
  });

  api.post('/settings/:group', (req: WebRequest, res: HttpResponse) => {
    const group = pstr(pstr(req.params.group));
    if (!SETTINGS_PERM[group]) {
      res.status(400).json({ success: false, message: 'Unknown settings group' });
      return;
    }
    if (!canEditSettings(req.user, group)) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    if (!settingsManager) {
      res.status(501).json({ success: false, message: 'Settings manager not available' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const result = settingsManager.apply(group, body);
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.error });
      return;
    }
    logger.info({ group, values: body, admin: req.user }, 'Runtime settings updated via panel');
    res.json({ success: true, ...settingsManager.list() });
  });

  api.post('/settings/:group/reset', (req: WebRequest, res: HttpResponse) => {
    const group = pstr(pstr(req.params.group));
    if (!SETTINGS_PERM[group]) {
      res.status(400).json({ success: false, message: 'Unknown settings group' });
      return;
    }
    if (!canEditSettings(req.user, group)) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    if (!settingsManager) {
      res.status(501).json({ success: false, message: 'Settings manager not available' });
      return;
    }
    const result = settingsManager.reset(group);
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.error });
      return;
    }
    logger.info({ group, admin: req.user }, 'Runtime settings reset to defaults');
    res.json({ success: true, ...settingsManager.list() });
  });

  // --- Client management ---
  api.post('/client/:id/kick', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'client:kick')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    try {
      client.ws.close(4000, 'Kicked by admin');
    } catch (_) {
      // ignore
    }
    clientManager.remove(pstr(req.params.id), 'admin_kick');
    logger.info({ clientId: pstr(req.params.id), admin: req.user }, 'Client kicked by admin');
    res.json({ success: true });
  });

  api.post('/broadcast', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'proxy:config')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const message = asString(body.message);
    const type = asString(body.type);
    if (!message) {
      res.status(400).json({ success: false, message: 'Message required' });
      return;
    }
    let count = 0;
    for (const c of clientManager.clients.values()) {
      try {
        c.ws.send(JSON.stringify({ type: 'broadcast', message, broadcastType: type || 'info' }));
        count++;
      } catch (_) {
        // ignore
      }
    }
    logger.info({ count, message: message.substring(0, 50) }, 'Broadcast sent');
    res.json({ success: true, count });
  });

  // --- Routing strategy ---
  api.post('/routing/strategy', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'routing:strategy')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const strategy = asString(body.strategy);
    if (!strategy) {
      res.status(400).json({ success: false, message: 'Strategy required' });
      return;
    }
    if (!clientManager.router) {
      res.status(400).json({ success: false, message: 'Router not available' });
      return;
    }
    const result = clientManager.router.setStrategy(strategy);
    if (result) {
      logger.info({ strategy, admin: req.user }, 'Routing strategy changed');
      if (clientManager.storage) clientManager.storage.setConfigOverride('routing_strategy', strategy);
      res.json({ success: true, strategy });
    } else {
      res.status(400).json({ success: false, message: 'Invalid strategy' });
    }
  });

  // --- Tags ---
  api.get('/tags', (_req: WebRequest, res: HttpResponse) => {
    res.json({ tags: clientManager.getAllTags() });
  });

  api.post('/client/:id/tags', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'client:tag')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const tags = body.tags;
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    if (!Array.isArray(tags)) {
      res.status(400).json({ success: false, message: 'Tags must be an array' });
      return;
    }
    const stringTags = tags as string[];
    client.tags = stringTags;
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { tags: stringTags });
    clientManager._notify();
    logger.info({ clientId: client.id, tags: stringTags, admin: req.user }, 'Client tags updated');
    res.json({ success: true, tags: stringTags });
  });

  api.post('/client/:id/weight', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'client:weight')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const weight = body.weight;
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    const w = parseFloat(str(weight));
    if (isNaN(w) || w < 1) {
      res.status(400).json({ success: false, message: 'Weight must be >= 1' });
      return;
    }
    clientManager.router?.setWeight(client.id, w);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { weight: w });
    res.json({ success: true, weight: w });
  });

  api.post('/client/:id/bandwidth', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'client:bandwidth')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const rate = body.rate;
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    const r = parseInt(str(rate), 10);
    if (isNaN(r) || r < 1024) {
      res.status(400).json({ success: false, message: 'Rate must be >= 1024 bytes/s' });
      return;
    }
    clientManager.bandwidthLimiter?.setLimit(client.id, r);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { bandwidth_limit: r });
    res.json({ success: true, rate: r });
  });

  api.post('/client/:id/alias', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'client:alias')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const alias = asString(body.alias);
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    clientManager.setAlias(client.id, alias);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { alias });
    logger.info({ clientId: client.id, alias, admin: req.user }, 'Client alias updated');
    res.json({ success: true, alias });
  });

  api.post('/client/:id/notes', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'client:notes')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const notes = asString(body.notes);
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    clientManager.setNotes(client.id, notes);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { notes });
    logger.info({ clientId: client.id, notes, admin: req.user }, 'Client notes updated');
    res.json({ success: true, notes });
  });

  api.post('/client/:id/region', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'client:region')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const region = asString(body.region);
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    clientManager.setRegion(client.id, region);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { region });
    logger.info({ clientId: client.id, region, admin: req.user }, 'Client region updated');
    res.json({ success: true, region });
  });

  api.post('/client/:id/circuit-breaker/reset', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'circuit:reset')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const client = clientManager.getById(pstr(req.params.id));
    if (!client) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    clientManager.circuitBreaker?.reset(client.id);
    res.json({ success: true });
  });

  api.get('/circuit-breaker/status', (_req: WebRequest, res: HttpResponse) => {
    res.json(clientManager.circuitBreaker?.getAllStatuses() || {});
  });

  api.get('/bandwidth/stats', (_req: WebRequest, res: HttpResponse) => {
    res.json(clientManager.bandwidthLimiter?.getStats() || {});
  });

  api.get('/client/:id/events', (req: WebRequest, res: HttpResponse) => {
    const limit = parseInt(str(req.query.limit), 10) || 50;
    const events = clientManager.storage?.getClientEvents(pstr(req.params.id), limit) || [];
    res.json({ events });
  });

  api.get('/client/:id/traffic', (req: WebRequest, res: HttpResponse) => {
    const since = parseInt(str(req.query.since), 10) || Date.now() - 86400000;
    const stats = clientManager.storage?.getTrafficStats(pstr(req.params.id), since) || {};
    res.json(stats);
  });

  // Daily traffic aggregation (frp-style per-day stats).
  // GET /api/v1/traffic?days=7&client_id=<id>   (client_id optional = all clients)
  api.get('/traffic', (req: WebRequest, res: HttpResponse) => {
    const days = Math.max(1, Math.min(30, parseInt(str(req.query.days), 10) || 7));
    const clientId = str(req.query.client_id) || null;
    // Validate client exists when specified (avoid leaking arbitrary ids via SQL)
    if (clientId && !clientManager.getById(clientId)) {
      res.status(400).json({ success: false, message: 'Unknown client' });
      return;
    }
    const storage = clientManager.storage;
    const daily = storage?.getTrafficDaily(clientId, days) || [];
    const totals = clientId
      ? storage?.getTrafficStats(clientId, 0) || { bytesSent: 0, bytesReceived: 0, requests: 0 }
      : storage?.getTrafficTotals() || { bytesSent: 0, bytesReceived: 0 };
    const last = daily[daily.length - 1];
    const today = last || { date: '', bytesSent: 0, bytesReceived: 0 };
    res.json({
      days,
      clientId,
      today: { bytesSent: today.bytesSent, bytesReceived: today.bytesReceived },
      daily,
      totals,
    });
  });

  // ===========================================================================
  // Phase 3: User Management API (RBAC)
  // ===========================================================================
  api.get('/users', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'user:list')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    res.json({ users: authManager.listUsers() });
  });

  api.post('/users', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'user:create')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const username = asString(body.username);
    const password = asString(body.password);
    const role = asString(body.role) || 'viewer';
    if (!username || !password) {
      res.status(400).json({ success: false, message: 'Username and password required' });
      return;
    }
    const result = authManager.addUser(username, password, (role || 'viewer') as RoleName);
    if (!result) {
      res.status(400).json({ success: false, message: 'User exists or invalid role' });
      return;
    }
    logger.info({ username, role, admin: req.user }, 'User created');
    res.json({ success: true });
  });

  api.delete('/users/:username', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'user:delete')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const result = authManager.deleteUser(pstr(req.params.username));
    if (!result) {
      res.status(400).json({ success: false, message: 'Cannot delete user or last admin' });
      return;
    }
    logger.info({ username: pstr(req.params.username), admin: req.user }, 'User deleted');
    res.json({ success: true });
  });

  api.patch('/users/:username', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'user:modify')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as { password?: string; role?: string; enabled?: boolean };
    const result = authManager.modifyUser(pstr(req.params.username), body);
    if (!result) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    logger.info({ username: pstr(req.params.username), updates: Object.keys(body), admin: req.user }, 'User modified');
    res.json({ success: true });
  });

  // ===========================================================================
  // Phase 3: Domain Rules API
  // ===========================================================================
  api.get('/domain-rules', (_req: WebRequest, res: HttpResponse) => {
    res.json({ rules: domainRouter?.listRules() || [] });
  });

  api.post('/domain-rules', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'domain:create')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const pattern = asString(body.pattern);
    const tag = asString(body.tag);
    const priority = asNum(body.priority);
    if (!pattern || !tag) {
      res.status(400).json({ success: false, message: 'Pattern and tag required' });
      return;
    }
    const result = domainRouter?.addRule(pattern, tag, priority || 0);
    if (result) {
      if (clientManager.storage && domainRouter) {
        clientManager.storage.setConfigOverride('domain_rules', domainRouter.listRules());
      }
      logger.info({ pattern, tag, admin: req.user }, 'Domain rule added');
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, message: 'Invalid pattern' });
    }
  });

  api.delete('/domain-rules', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'domain:delete')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const pattern = asString(body.pattern);
    if (!pattern) {
      res.status(400).json({ success: false, message: 'Pattern required' });
      return;
    }
    const result = domainRouter?.removeRule(pattern);
    if (result) {
      if (clientManager.storage && domainRouter) {
        clientManager.storage.setConfigOverride('domain_rules', domainRouter.listRules());
      }
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: 'Rule not found' });
    }
  });

  // ===========================================================================
  // Phase 3: Cache API
  // ===========================================================================
  api.get('/cache/stats', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'cache:view')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    res.json(cache?.stats() || { enabled: false });
  });

  api.post('/cache/clear', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'cache:clear')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    cache?.clear();
    logger.info({ admin: req.user }, 'Cache cleared');
    res.json({ success: true });
  });

  // ===========================================================================
  // Phase 3: Plugin API
  // ===========================================================================
  api.get('/plugins', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'plugin:list')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    res.json({ plugins: pluginManager?.list() || [] });
  });

  api.post('/plugins/:name/enable', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'plugin:install')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const result = pluginManager?.enable(pstr(req.params.name));
    if (result) {
      res.json({ success: true });
      return;
    }
    res.status(404).json({ success: false, message: 'Plugin not found' });
  });

  api.post('/plugins/:name/disable', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'plugin:install')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const result = pluginManager?.disable(pstr(req.params.name));
    if (result) {
      res.json({ success: true });
      return;
    }
    res.status(404).json({ success: false, message: 'Plugin not found' });
  });

  api.post('/plugins/:name/reload', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'plugin:install')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const result = pluginManager?.reload(pstr(req.params.name));
    if (result && result.success) {
      res.json({ success: true });
      return;
    }
    res.status(400).json(result || { success: false });
  });

  api.delete('/plugins/:name', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'plugin:uninstall')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const result = pluginManager?.uninstall(pstr(req.params.name));
    if (result && result.success) {
      res.json({ success: true });
      return;
    }
    res.status(400).json(result || { success: false });
  });

  // ===========================================================================
  // Phase 3: ACL Rules API
  // ===========================================================================
  api.get('/acl/rules', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'acl:list')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    res.json({ rules: aclManager?.listRules() || [] });
  });

  api.post('/acl/rules', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'acl:create')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const result = aclManager?.addRule(body);
    if (result) {
      logger.info({ rule: body, admin: req.user }, 'ACL rule added');
      res.json({ success: true });
      return;
    }
    res.status(400).json({ success: false, message: 'Invalid rule' });
  });

  api.delete('/acl/rules/:ruleId', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'acl:delete')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const result = aclManager?.removeRule(pstr(req.params.ruleId));
    if (result) {
      res.json({ success: true });
      return;
    }
    res.status(404).json({ success: false, message: 'Rule not found' });
  });

  api.get('/acl/stats', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'acl:list')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    res.json(aclManager?.getStats() || {});
  });

  // ===========================================================================
  // Phase 3: Audit Log API
  // ===========================================================================
  api.get('/audit/query', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'audit:query')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    const result = auditLogger?.query({
      type: str(req.query.type),
      limit: parseInt(str(req.query.limit), 10) || 100,
      offset: parseInt(str(req.query.offset), 10) || 0,
      since: str(req.query.since),
      until: str(req.query.until),
      clientId: str(req.query.clientId),
      username: str(req.query.username),
    });
    res.json(result);
  });

  api.get('/audit/stats', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'audit:query')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    res.json(auditLogger?.getStats() || {});
  });

  // ===========================================================================
  // Phase 3: Auto Update API
  // ===========================================================================
  api.get('/update/status', (_req: WebRequest, res: HttpResponse) => {
    res.json(autoUpdater?.getStatus() || { enabled: false });
  });

  api.post('/update/check', (req: WebRequest, res: HttpResponse) => {
    if (!authManager.hasPermission(str(req.user), 'system:config')) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }
    if (autoUpdater) {
      autoUpdater.triggerCheck();
      res.json({ success: true, message: 'Update check triggered' });
    } else {
      res.status(400).json({ success: false, message: 'Auto updater not available' });
    }
  });

  // ===========================================================================
  // Phase 4: Stream Multiplexer Stats
  // ===========================================================================
  api.get('/mux/stats', (_req: WebRequest, res: HttpResponse) => {
    const stats: { clientId: string; tags: string[]; mux: Record<string, unknown> }[] = [];
    for (const [id, client] of clientManager.clients) {
      if (client.mux) {
        const muxStats = (client.mux as unknown as { getStats(): Record<string, unknown> }).getStats();
        stats.push({ clientId: id, tags: client.tags, mux: muxStats });
      }
    }
    res.json({ clients: stats, total: stats.length });
  });

  // Mount API v1
  app.use('/api/v1', api);
  // Also mount legacy routes at /api directly
  app.use('/api', api);

  return app;
}

module.exports = { createWebServer };

