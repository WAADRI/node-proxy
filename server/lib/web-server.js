// =============================================================================
// Web Server v3.0 - Express app with full Phase 3 API
// =============================================================================
'use strict';

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

function createWebServer(clientManager, authManager, config, logger, metricsManager, domainRouter, cache, pluginManager, aclManager, auditLogger, autoUpdater, settingsManager) {
  const app = express();

  // Trust the first upstream proxy (nginx) so req.ip reads X-Forwarded-For
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ===========================================================================
  // Auth Routes
  // ===========================================================================
  app.get('/login', (req, res) => {
    if (!config.auth.web.enabled) return res.redirect('/');
    res.sendFile(path.join(__dirname, '..', 'views', 'login.html'));
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (authManager.validateWebLogin(username, password)) {
      const token = authManager.generateWebToken(username);
      const role = authManager.getRole(username);
      logger.info({ username, role }, 'Web login success');
      res.json({ success: true, token, role, redirect: '/' });
    } else {
      logger.warn({ username, ip: req.ip }, 'Web login failed');
      res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
  });

  app.post('/api/logout', (req, res) => {
    res.json({ success: true });
  });

  app.use(authManager.webAuthMiddleware());

  // ===========================================================================
  // Dashboard
  // ===========================================================================
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'dashboard.html'));
  });

  // ===========================================================================
  // Metrics endpoint
  // ===========================================================================
  if (metricsManager) {
    app.get('/metrics', metricsManager.metricsMiddleware());
  }

  // ===========================================================================
  // Swagger / OpenAPI docs
  // ===========================================================================
  const { setupSwagger } = require('./swagger');
  setupSwagger(app);

  // ===========================================================================
  // API v1 Routes
  // ===========================================================================
  const api = express.Router();

  // --- Status ---
  api.get('/status', (req, res) => {
    res.json(clientManager.getStats());
  });

  api.get('/config', (req, res) => {
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
  const SETTINGS_PERM = { routing: 'routing:strategy', circuit_breaker: 'system:config', bandwidth: 'system:config', client: 'system:config', cache: 'system:config' };

  function canEditSettings(user, group) {
    const perm = SETTINGS_PERM[group];
    if (!perm) return false;
    return authManager.hasPermission(user, perm) || authManager.hasPermission(user, 'system:config');
  }

  api.get('/settings', (req, res) => {
    if (!settingsManager) return res.status(501).json({ success: false, message: 'Settings manager not available' });
    const data = settingsManager.list();
    const editable = {};
    for (const g of Object.keys(SETTINGS_PERM)) editable[g] = canEditSettings(req.user, g);
    res.json({ success: true, ...data, editable });
  });

  api.post('/settings/:group', (req, res) => {
    const { group } = req.params;
    if (!SETTINGS_PERM[group]) return res.status(400).json({ success: false, message: 'Unknown settings group' });
    if (!canEditSettings(req.user, group)) return res.status(403).json({ success: false, message: 'Permission denied' });
    if (!settingsManager) return res.status(501).json({ success: false, message: 'Settings manager not available' });
    const result = settingsManager.apply(group, req.body || {});
    if (!result.ok) return res.status(400).json({ success: false, message: result.error });
    logger.info({ group, values: req.body, admin: req.user }, 'Runtime settings updated via panel');
    res.json({ success: true, ...settingsManager.list() });
  });

  api.post('/settings/:group/reset', (req, res) => {
    const { group } = req.params;
    if (!SETTINGS_PERM[group]) return res.status(400).json({ success: false, message: 'Unknown settings group' });
    if (!canEditSettings(req.user, group)) return res.status(403).json({ success: false, message: 'Permission denied' });
    if (!settingsManager) return res.status(501).json({ success: false, message: 'Settings manager not available' });
    const result = settingsManager.reset(group);
    if (!result.ok) return res.status(400).json({ success: false, message: result.error });
    logger.info({ group, admin: req.user }, 'Runtime settings reset to defaults');
    res.json({ success: true, ...settingsManager.list() });
  });

  // --- Client management ---
  api.post('/client/:id/kick', (req, res) => {
    if (!authManager.hasPermission(req.user, 'client:kick')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    try { client.ws.close(4000, 'Kicked by admin'); } catch (_) {}
    clientManager.remove(req.params.id, 'admin_kick');
    logger.info({ clientId: req.params.id, admin: req.user }, 'Client kicked by admin');
    res.json({ success: true });
  });

  api.post('/broadcast', (req, res) => {
    if (!authManager.hasPermission(req.user, 'proxy:config')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { message, type } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });
    let count = 0;
    for (const [, c] of clientManager.clients) {
      try { c.ws.send(JSON.stringify({ type: 'broadcast', message, broadcastType: type || 'info' })); count++; } catch (_) {}
    }
    logger.info({ count, message: message.substring(0, 50) }, 'Broadcast sent');
    res.json({ success: true, count });
  });

  // --- Routing strategy ---
  api.post('/routing/strategy', (req, res) => {
    if (!authManager.hasPermission(req.user, 'routing:strategy')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { strategy } = req.body;
    if (!strategy) return res.status(400).json({ success: false, message: 'Strategy required' });
    if (!clientManager.router) return res.status(400).json({ success: false, message: 'Router not available' });
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
  api.get('/tags', (req, res) => {
    res.json({ tags: clientManager.getAllTags() });
  });

  api.post('/client/:id/tags', (req, res) => {
    if (!authManager.hasPermission(req.user, 'client:tag')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { tags } = req.body;
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    if (!Array.isArray(tags)) return res.status(400).json({ success: false, message: 'Tags must be an array' });
    client.tags = tags;
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { tags });
    clientManager._notify();
    logger.info({ clientId: client.id, tags, admin: req.user }, 'Client tags updated');
    res.json({ success: true, tags });
  });

  api.post('/client/:id/weight', (req, res) => {
    if (!authManager.hasPermission(req.user, 'client:weight')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { weight } = req.body;
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const w = parseFloat(weight);
    if (isNaN(w) || w < 1) return res.status(400).json({ success: false, message: 'Weight must be >= 1' });
    clientManager.router?.setWeight(client.id, w);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { weight: w });
    res.json({ success: true, weight: w });
  });

  api.post('/client/:id/bandwidth', (req, res) => {
    if (!authManager.hasPermission(req.user, 'client:bandwidth')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { rate } = req.body;
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const r = parseInt(rate, 10);
    if (isNaN(r) || r < 1024) return res.status(400).json({ success: false, message: 'Rate must be >= 1024 bytes/s' });
    clientManager.bandwidthLimiter?.setLimit(client.id, r);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { bandwidth_limit: r });
    res.json({ success: true, rate: r });
  });

  api.post('/client/:id/alias', (req, res) => {
    if (!authManager.hasPermission(req.user, 'client:alias')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { alias } = req.body;
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    clientManager.setAlias(client.id, alias);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { alias });
    logger.info({ clientId: client.id, alias, admin: req.user }, 'Client alias updated');
    res.json({ success: true, alias });
  });

  api.post('/client/:id/notes', (req, res) => {
    if (!authManager.hasPermission(req.user, 'client:notes')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { notes } = req.body;
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    clientManager.setNotes(client.id, notes);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { notes });
    logger.info({ clientId: client.id, notes, admin: req.user }, 'Client notes updated');
    res.json({ success: true, notes });
  });

  api.post('/client/:id/region', (req, res) => {
    if (!authManager.hasPermission(req.user, 'client:region')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { region } = req.body;
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    clientManager.setRegion(client.id, region);
    if (clientManager.storage) clientManager.storage.setClientMetadata(client.id, { region });
    logger.info({ clientId: client.id, region, admin: req.user }, 'Client region updated');
    res.json({ success: true, region });
  });

  api.post('/client/:id/circuit-breaker/reset', (req, res) => {
    if (!authManager.hasPermission(req.user, 'circuit:reset')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const client = clientManager.getById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    clientManager.circuitBreaker?.reset(client.id);
    res.json({ success: true });
  });

  api.get('/circuit-breaker/status', (req, res) => {
    res.json(clientManager.circuitBreaker?.getAllStatuses() || {});
  });

  api.get('/bandwidth/stats', (req, res) => {
    res.json(clientManager.bandwidthLimiter?.getStats() || {});
  });

  api.get('/client/:id/events', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const events = clientManager.storage?.getClientEvents(req.params.id, limit) || [];
    res.json({ events });
  });

  api.get('/client/:id/traffic', (req, res) => {
    const since = parseInt(req.query.since, 10) || (Date.now() - 86400000);
    const stats = clientManager.storage?.getTrafficStats(req.params.id, since) || {};
    res.json(stats);
  });

  // Daily traffic aggregation (frp-style per-day stats).
  // GET /api/v1/traffic?days=7&client_id=<id>   (client_id optional = all clients)
  api.get('/traffic', (req, res) => {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
    const clientId = req.query.client_id || null;
    // Validate client exists when specified (avoid leaking arbitrary ids via SQL)
    if (clientId && !clientManager.getById(clientId)) {
      return res.status(400).json({ success: false, message: 'Unknown client' });
    }
    const storage = clientManager.storage;
    const daily = storage?.getTrafficDaily(clientId, days) || [];
    const totals = clientId
      ? storage?.getTrafficStats(clientId, 0) || { bytesSent: 0, bytesReceived: 0 }
      : storage?.getTrafficTotals() || { bytesSent: 0, bytesReceived: 0 };
    const today = daily[daily.length - 1] || { bytesSent: 0, bytesReceived: 0 };
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
  api.get('/users', (req, res) => {
    if (!authManager.hasPermission(req.user, 'user:list')) return res.status(403).json({ success: false, message: 'Permission denied' });
    res.json({ users: authManager.listUsers() });
  });

  api.post('/users', (req, res) => {
    if (!authManager.hasPermission(req.user, 'user:create')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required' });
    const result = authManager.addUser(username, password, role || 'viewer');
    if (!result) return res.status(400).json({ success: false, message: 'User exists or invalid role' });
    logger.info({ username, role: role || 'viewer', admin: req.user }, 'User created');
    res.json({ success: true });
  });

  api.delete('/users/:username', (req, res) => {
    if (!authManager.hasPermission(req.user, 'user:delete')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = authManager.deleteUser(req.params.username);
    if (!result) return res.status(400).json({ success: false, message: 'Cannot delete user or last admin' });
    logger.info({ username: req.params.username, admin: req.user }, 'User deleted');
    res.json({ success: true });
  });

  api.patch('/users/:username', (req, res) => {
    if (!authManager.hasPermission(req.user, 'user:modify')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = authManager.modifyUser(req.params.username, req.body);
    if (!result) return res.status(404).json({ success: false, message: 'User not found' });
    logger.info({ username: req.params.username, updates: Object.keys(req.body), admin: req.user }, 'User modified');
    res.json({ success: true });
  });

  // ===========================================================================
  // Phase 3: Domain Rules API
  // ===========================================================================
  api.get('/domain-rules', (req, res) => {
    res.json({ rules: domainRouter?.listRules() || [] });
  });

  api.post('/domain-rules', (req, res) => {
    if (!authManager.hasPermission(req.user, 'domain:create')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { pattern, tag, priority } = req.body;
    if (!pattern || !tag) return res.status(400).json({ success: false, message: 'Pattern and tag required' });
    const result = domainRouter?.addRule(pattern, tag, priority || 0);
    if (result) {
      if (clientManager.storage) clientManager.storage.setConfigOverride('domain_rules', domainRouter.listRules());
      logger.info({ pattern, tag, admin: req.user }, 'Domain rule added');
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, message: 'Invalid pattern' });
    }
  });

  api.delete('/domain-rules', (req, res) => {
    if (!authManager.hasPermission(req.user, 'domain:delete')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const { pattern } = req.body;
    if (!pattern) return res.status(400).json({ success: false, message: 'Pattern required' });
    const result = domainRouter?.removeRule(pattern);
    if (result) {
      if (clientManager.storage) clientManager.storage.setConfigOverride('domain_rules', domainRouter.listRules());
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: 'Rule not found' });
    }
  });

  // ===========================================================================
  // Phase 3: Cache API
  // ===========================================================================
  api.get('/cache/stats', (req, res) => {
    if (!authManager.hasPermission(req.user, 'cache:view')) return res.status(403).json({ success: false, message: 'Permission denied' });
    res.json(cache?.stats() || { enabled: false });
  });

  api.post('/cache/clear', (req, res) => {
    if (!authManager.hasPermission(req.user, 'cache:clear')) return res.status(403).json({ success: false, message: 'Permission denied' });
    cache?.clear();
    logger.info({ admin: req.user }, 'Cache cleared');
    res.json({ success: true });
  });

  // ===========================================================================
  // Phase 3: Plugin API
  // ===========================================================================
  api.get('/plugins', (req, res) => {
    if (!authManager.hasPermission(req.user, 'plugin:list')) return res.status(403).json({ success: false, message: 'Permission denied' });
    res.json({ plugins: pluginManager?.list() || [] });
  });

  api.post('/plugins/:name/enable', (req, res) => {
    if (!authManager.hasPermission(req.user, 'plugin:install')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = pluginManager?.enable(req.params.name);
    if (result) return res.json({ success: true });
    res.status(404).json({ success: false, message: 'Plugin not found' });
  });

  api.post('/plugins/:name/disable', (req, res) => {
    if (!authManager.hasPermission(req.user, 'plugin:install')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = pluginManager?.disable(req.params.name);
    if (result) return res.json({ success: true });
    res.status(404).json({ success: false, message: 'Plugin not found' });
  });

  api.post('/plugins/:name/reload', (req, res) => {
    if (!authManager.hasPermission(req.user, 'plugin:install')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = pluginManager?.reload(req.params.name);
    if (result.success) return res.json({ success: true });
    res.status(400).json(result);
  });

  api.delete('/plugins/:name', (req, res) => {
    if (!authManager.hasPermission(req.user, 'plugin:uninstall')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = pluginManager?.uninstall(req.params.name);
    if (result.success) return res.json({ success: true });
    res.status(400).json(result);
  });

  // ===========================================================================
  // Phase 3: ACL Rules API
  // ===========================================================================
  api.get('/acl/rules', (req, res) => {
    if (!authManager.hasPermission(req.user, 'acl:list')) return res.status(403).json({ success: false, message: 'Permission denied' });
    res.json({ rules: aclManager?.listRules() || [] });
  });

  api.post('/acl/rules', (req, res) => {
    if (!authManager.hasPermission(req.user, 'acl:create')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = aclManager?.addRule(req.body);
    if (result) {
      logger.info({ rule: req.body, admin: req.user }, 'ACL rule added');
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, message: 'Invalid rule' });
  });

  api.delete('/acl/rules/:ruleId', (req, res) => {
    if (!authManager.hasPermission(req.user, 'acl:delete')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = aclManager?.removeRule(req.params.ruleId);
    if (result) return res.json({ success: true });
    res.status(404).json({ success: false, message: 'Rule not found' });
  });

  api.get('/acl/stats', (req, res) => {
    if (!authManager.hasPermission(req.user, 'acl:list')) return res.status(403).json({ success: false, message: 'Permission denied' });
    res.json(aclManager?.getStats() || {});
  });

  // ===========================================================================
  // Phase 3: Audit Log API
  // ===========================================================================
  api.get('/audit/query', (req, res) => {
    if (!authManager.hasPermission(req.user, 'audit:query')) return res.status(403).json({ success: false, message: 'Permission denied' });
    const result = auditLogger?.query({
      type: req.query.type,
      limit: parseInt(req.query.limit, 10) || 100,
      offset: parseInt(req.query.offset, 10) || 0,
      since: req.query.since,
      until: req.query.until,
      clientId: req.query.clientId,
      username: req.query.username,
    });
    res.json(result);
  });

  api.get('/audit/stats', (req, res) => {
    if (!authManager.hasPermission(req.user, 'audit:query')) return res.status(403).json({ success: false, message: 'Permission denied' });
    res.json(auditLogger?.getStats() || {});
  });

  // ===========================================================================
  // Phase 3: Auto Update API
  // ===========================================================================
  api.get('/update/status', (req, res) => {
    res.json(autoUpdater?.getStatus() || { enabled: false });
  });

  api.post('/update/check', (req, res) => {
    if (!authManager.hasPermission(req.user, 'system:config')) return res.status(403).json({ success: false, message: 'Permission denied' });
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
  api.get('/mux/stats', (req, res) => {
    const stats = [];
    for (const [id, client] of clientManager.clients) {
      if (client.mux) {
        stats.push({
          clientId: id,
          tags: client.tags,
          mux: client.mux.getStats(),
        });
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