#!/usr/bin/env node

// =============================================================================
// Node-Proxy Server v3.0 - Main Entry Point
// Phase 3: Multi-user RBAC, Domain router, Cache, Swagger, Plugin, ACME
// =============================================================================
'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

// Load configuration first
const { loadConfig } = require('./lib/config');
const config = loadConfig();

// Initialize logger
const { createLogger } = require('./lib/logger');
const logger = createLogger({
  level: config.logging.level,
  logFile: config.logging.file || undefined,
  maxSize: config.logging.max_size,
  maxFiles: config.logging.max_files,
  pretty: config.logging.pretty || false,
});

logger.info('Node-Proxy Server v3.0 starting...');

// Initialize modules
const { AuthManager } = require('./lib/auth');
const { ClientManager } = require('./lib/client-manager');
const { CircuitBreaker } = require('./lib/circuit-breaker');
const { Router } = require('./lib/router');
const { BandwidthLimiter } = require('./lib/bandwidth');
const { Storage } = require('./lib/storage');
const { MetricsManager } = require('./lib/metrics');
const { DomainRouter } = require('./lib/domain-router');
const { RequestCache } = require('./lib/cache');
const { PluginManager } = require('./lib/plugin-manager');
const { ACMEManager } = require('./lib/acme');
const { createHttpProxy } = require('./lib/proxy-http');
const { createSocks5Proxy } = require('./lib/proxy-socks5');
const { createWebServer } = require('./lib/web-server');
const { setupClientWebSocket } = require('./lib/ws-server');
const { loadTLSCredentials } = require('./lib/tls');

// Initialize auth
const authManager = new AuthManager(config, logger);

// Initialize Phase 2 modules
const circuitBreaker = new CircuitBreaker(config, logger);
const router = new Router(config, logger);
const bandwidthLimiter = new BandwidthLimiter(config, logger);
const storage = new Storage(config, logger);
const metricsManager = new MetricsManager(config, logger);

// Initialize Phase 3 modules
const domainRouter = new DomainRouter(config, logger);
const cache = new RequestCache(config, logger);
const pluginManager = new PluginManager(config, logger);
const acmeManager = new ACMEManager(config, logger);
const aclManager = new (require('./lib/acl').ACLManager)(config, logger);
const auditLogger = new (require('./lib/audit').AuditLogger)(config, logger);
const autoUpdater = new (require('./lib/auto-update').AutoUpdater)(config, logger);

// Initialize client manager and wire up dependencies
const clientManager = new ClientManager(config, logger);
clientManager.circuitBreaker = circuitBreaker;
clientManager.router = router;
clientManager.bandwidthLimiter = bandwidthLimiter;
clientManager.storage = storage;
clientManager.metrics = metricsManager;
clientManager.domainRouter = domainRouter;
clientManager.cache = cache;
clientManager.acl = aclManager;
clientManager.audit = auditLogger;
clientManager.pluginManager = pluginManager;

// Load persisted routing strategy
if (storage.available) {
  const savedStrategy = storage.getConfigOverride('routing_strategy');
  if (savedStrategy) {
    router.setStrategy(savedStrategy);
    logger.info({ strategy: savedStrategy }, 'Loaded persisted routing strategy');
  }
}

// Create web app (pass all Phase 3 modules)
const app = createWebServer(clientManager, authManager, config, logger, metricsManager, domainRouter, cache, pluginManager, aclManager, auditLogger, autoUpdater);
const httpServer = http.createServer(app);

// Setup WebSocket servers
const clientWss = setupClientWebSocket(httpServer, clientManager, authManager, config, logger);

// Web UI WebSocket for live updates
const { WebSocketServer } = require('ws');
const webWss = new WebSocketServer({ noServer: true });

webWss.on('connection', (ws) => {
  try {
    ws.send(JSON.stringify({ type: 'status', data: clientManager.getStats() }));
  } catch (_) {}

  const onChange = () => {
    try {
      ws.send(JSON.stringify({ type: 'status', data: clientManager.getStats() }));
    } catch (_) {}
  };
  clientManager.onChange(onChange);

  ws.on('close', () => { clientManager.onChange = null; });
  ws.on('error', () => {});
});

// Handle HTTP upgrade for WebSocket
httpServer.on('upgrade', (request, socket, head) => {
  const urlObj = url.parse(request.url);
  if (urlObj.pathname === '/ws') {
    clientWss.handleUpgrade(request, socket, head, (ws) => {
      clientWss.emit('connection', ws, request);
    });
  } else if (urlObj.pathname === '/web-ws') {
    const token = extractToken(request);
    if (token) {
      const result = authManager.verifyWebToken(token);
      if (result.valid) {
        webWss.handleUpgrade(request, socket, head, (ws) => {
          webWss.emit('connection', ws, request);
        });
        return;
      }
    }
    if (!config.auth.web.enabled) {
      webWss.handleUpgrade(request, socket, head, (ws) => {
        webWss.emit('connection', ws, request);
      });
      return;
    }
    socket.destroy();
  } else {
    socket.destroy();
  }
});

function extractToken(req) {
  const urlObj = url.parse(req.url, true);
  if (urlObj.query && urlObj.query.token) return urlObj.query.token;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers['cookie'];
  if (cookie) {
    const match = cookie.match(/token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

// =============================================================================
// Start Services
// =============================================================================

// Determine listen address for IPv6 dual-stack support
// Use '::' for IPv6 dual-stack (accepts both IPv4 and IPv6 connections)
const listenHost = config.server.host === '0.0.0.0' ? '::' : config.server.host;
// Check if IPv6 is explicitly requested
const isIPv6Only = config.server.ipv6_only || false;

// 1. HTTP Proxy
const httpProxy = createHttpProxy(clientManager, authManager, config, logger, domainRouter, cache, pluginManager);
httpProxy.listen(config.server.http_proxy_port, isIPv6Only ? '::' : listenHost, () => {
  logger.info({ port: config.server.http_proxy_port }, 'HTTP proxy started');
});

// 2. SOCKS5 Proxy
const socks5 = createSocks5Proxy(clientManager, authManager, config, logger, pluginManager);
socks5.listen(config.server.socks5_port, isIPv6Only ? '::' : listenHost, () => {
  logger.info({ port: config.server.socks5_port }, 'SOCKS5 proxy started');
});

// 3. Web Server (with optional TLS)
const tlsCreds = loadTLSCredentials(config);

if (tlsCreds) {
  const httpsServer = https.createServer(tlsCreds, app);
  httpsServer.on('upgrade', (request, socket, head) => {
    httpServer.emit('upgrade', request, socket, head);
  });
  httpsServer.listen(config.server.web_port, isIPv6Only ? '::' : listenHost, () => {
    logger.info({ port: config.server.web_port, tls: true }, 'Web server (HTTPS) started');
  });
} else {
  httpServer.listen(config.server.web_port, config.server.host, () => {
    logger.info({ port: config.server.web_port, tls: false }, 'Web server (HTTP) started');
  });
}

// =============================================================================
// Health Checks
// =============================================================================
clientManager.startHealthChecks();

// =============================================================================
// Periodic cleanup of old data
// =============================================================================
setInterval(() => {
  storage.cleanupOldData(30);
  // Cleanup stale stats in router and bandwidth limiter
  const activeIds = Array.from(clientManager.clients.keys());
  router.cleanup(activeIds);
  bandwidthLimiter.cleanup(activeIds);
}, 3600000); // Every hour

// =============================================================================
// Startup summary
// =============================================================================
setTimeout(() => {
  const authStatus = config.auth.proxy.enabled ? 'enabled' : 'disabled';
  const tlsStatus = tlsCreds ? 'enabled' : 'disabled';
  const webAuthStatus = config.auth.web.enabled ? 'enabled' : 'disabled';
  const storageStatus = storage.available ? 'enabled' : 'disabled';
  const metricsStatus = metricsManager.enabled ? 'enabled' : 'disabled';
  const cbStatus = 'enabled';
  const bwStatus = config.bandwidth?.enabled ? 'enabled' : 'disabled';
  const pluginCount = pluginManager.list().length;
  const ruleCount = domainRouter.listRules().length;
  const userCount = authManager.listUsers().length;
  const aclCount = aclManager.listRules().length;

  logger.info('============================================');
  logger.info('  Node-Proxy Server v3.0');
  logger.info('============================================');
  logger.info(`  Web Panel:     http${tlsCreds ? 's' : ''}://${config.server.host}:${config.server.web_port}`);
  logger.info(`  HTTP Proxy:    ${config.server.host}:${config.server.http_proxy_port}`);
  logger.info(`  SOCKS5 Proxy:  ${config.server.host}:${config.server.socks5_port}`);
  logger.info(`  Client WS:     ws${tlsCreds ? 's' : ''}://${config.server.host}:${config.server.web_port}/ws`);
  logger.info(`  Metrics:       http://${config.server.host}:${config.server.web_port}/metrics`);
  logger.info(`  API Docs:      http://${config.server.host}:${config.server.web_port}/api/docs`);
  logger.info(`  IPv6:          ${isIPv6Only ? 'IPv6 only' : 'Dual-stack'}`);
  logger.info('--- Phase 2 ---');
  logger.info(`  Routing:       ${router.strategy}`);
  logger.info(`  Circuit Brk:   enabled`);
  logger.info(`  Bandwidth:     ${config.bandwidth?.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`  Storage:       ${storage.available ? 'enabled' : 'disabled'}`);
  logger.info(`  Metrics:       ${metricsManager.enabled ? 'enabled' : 'disabled'}`);
  logger.info('--- Phase 3 ---');
  logger.info(`  RBAC:          ${userCount} users`);
  logger.info(`  Domain Rules:  ${ruleCount} rules`);
  logger.info(`  Cache:         ${cache.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`  Plugins:       ${pluginCount} loaded`);
  logger.info(`  ACME:          ${acmeManager.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`  ACL:           ${aclCount} rules`);
  logger.info(`  Audit:         ${auditLogger.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`  Auto Update:   ${autoUpdater.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`  UDP Assoc:     enabled`);
  logger.info('---');
  logger.info(`  TLS:           ${tlsStatus}`);
  logger.info(`  Proxy Auth:    ${authStatus}`);
  logger.info(`  Web Auth:      ${webAuthStatus}`);
  logger.info(`  Log Level:     ${config.logging.level}`);
  logger.info('============================================');
}, 100);

// =============================================================================
// Graceful Shutdown
// =============================================================================
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  clientManager.stopHealthChecks();
  for (const [id, client] of clientManager.clients) {
    try { client.ws.close(1001, 'Server shutting down'); } catch (_) {}
  }
  storage.close();
  auditLogger.shutdown();
  autoUpdater.shutdown();
  if (acmeManager.enabled) acmeManager.stop();
  setTimeout(() => {
    logger.info('Goodbye');
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.fatal({ error: err.stack }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ error: reason }, 'Unhandled rejection');
});