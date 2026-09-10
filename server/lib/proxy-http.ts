// =============================================================================
// HTTP Proxy - HTTP/HTTPS CONNECT proxy with authentication
// v2.1 - Uses router, bandwidth limiter, circuit breaker
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; loaded by
// require('./lib/proxy-http.ts') under Node >= 24 type stripping.
// =============================================================================

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket as NetSocket } from 'net';
import { v4 as uuidv4 } from 'uuid';
import type { ClientManager } from './client-manager.ts';
import type { ServerConfig } from './config.ts';
import type { AppLogger } from './logger.ts';
import type { DomainRouter } from './domain-router.ts';
import type { RequestCache, HeadersLike } from './cache.ts';
import type { ProxyRoute } from './auth.ts';

// plugin-manager is a CJS-style module without an exported class type; the
// proxy only needs the fire-and-forget hook entry point.
interface PluginManagerLike {
  executeHook(hookName: string, context: unknown): unknown;
}

// Auth contract: resolveProxyAuth additionally returns the per-password
// routing directive (tag / forced node UUID / strategy, issue #53).
interface HttpAuthManagerLike {
  resolveProxyAuth(header: string | string[] | undefined): { ok: boolean; route?: ProxyRoute };
}

// Both ServerResponse (request-event CONNECT branch) and the raw net.Socket
// ('connect' event) satisfy the tunnel-facing operations used below.
interface ConnectTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  write(chunk: string | Buffer): boolean;
  end(chunk?: string | Buffer): unknown;
  destroyed: boolean;
}

export function createHttpProxy(
  clientManager: ClientManager,
  authManager: HttpAuthManagerLike,
  config: ServerConfig,
  logger: AppLogger,
  domainRouter: DomainRouter | null,
  cache: RequestCache | null,
  pluginManager: PluginManagerLike | null
) {
  const server = http.createServer((req, res) => {
    if (req.method === 'CONNECT') {
      handleConnect(req, res as unknown as ConnectTarget, clientManager, authManager, config, logger, domainRouter, pluginManager);
      return;
    }
    handleHttpRequest(req, res, clientManager, authManager, config, logger, domainRouter, cache, pluginManager);
  });

  server.on('connect', (req, socket, head) => {
    handleConnect(req, socket as unknown as ConnectTarget, clientManager, authManager, config, logger, domainRouter, head, pluginManager);
  });

  return server;
}

// Fire-and-forget plugin hook execution (never blocks or breaks the proxy path)
function runPluginHook(pluginManager: PluginManagerLike | null | undefined, hook: string, context: Record<string, unknown>) {
  if (!pluginManager || typeof pluginManager.executeHook !== 'function') return;
  Promise.resolve(pluginManager.executeHook(hook, context)).catch(() => {});
}

// Resolves proxy credentials and returns the routing directive, or null when
// authentication fails (caller responds 407).
function checkProxyAuth(
  req: IncomingMessage,
  authManager: HttpAuthManagerLike,
  logger: AppLogger
): ProxyRoute | null {
  const authHeader = req.headers['proxy-authorization'];
  const result = authManager.resolveProxyAuth(authHeader);
  if (!result.ok) {
    logger.warn({ ip: req.socket.remoteAddress, method: req.method, url: req.url }, 'Proxy auth failed');
    return null;
  }
  return result.route || {};
}

// Best-effort real client IP: honour X-Forwarded-For when a reverse proxy
// (e.g. nginx) terminates the client connection, otherwise use the socket.
// IPv4-mapped IPv6 form (::ffff:1.2.3.4) from dual-stack listening is
// normalised back to plain IPv4 for display.
function clientIp(req: IncomingMessage): string {
  const norm = (v: string | undefined | null): string => String(v || '').replace(/^::ffff:/i, '');
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return norm(first);
  }
  return norm(req.socket && req.socket.remoteAddress);
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders): HeadersLike {
  const sanitized: HeadersLike = { ...headers };
  delete sanitized['proxy-authorization'];
  delete sanitized['proxy-connection'];
  delete sanitized['connection'];
  return sanitized;
}

function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  clientManager: ClientManager,
  authManager: HttpAuthManagerLike,
  config: ServerConfig,
  logger: AppLogger,
  domainRouter: DomainRouter | null,
  cache: RequestCache | null,
  pluginManager: PluginManagerLike | null
) {
  const startedAt = Date.now();
  const route = checkProxyAuth(req, authManager, logger);
  if (!route) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Node-Proxy"', 'Content-Type': 'text/plain' });
    res.end('Proxy authentication required');
    return;
  }

  // Plugin hook: onRequest
  runPluginHook(pluginManager, 'onRequest', {
    req,
    res,
    clientManager,
    method: req.method,
    url: req.url,
    headers: req.headers,
    ip: clientIp(req),
    timestamp: startedAt,
  });

  // Plugin hook: onResponse (when response finishes) + record into LogHub
  res.on('finish', () => {
    const entry = {
      ts: Date.now(),
      ip: clientIp(req),
      method: req.method,
      url: req.url,
      status: res.statusCode || 0,
      ms: Date.now() - startedAt,
    };
    if (clientManager.requestLog) {
      try {
        clientManager.requestLog.record(entry);
      } catch (_) {
        // ignore
      }
    }
    runPluginHook(pluginManager, 'onResponse', {
      req,
      res,
      clientManager,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: entry.ms,
      ip: entry.ip,
      timestamp: entry.ts,
    });
  });

  // Extract target URL for domain routing
  let targetUrl = req.url || '';
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = `http://${req.headers.host || 'unknown'}${targetUrl}`;
  }
  let targetHost = '';
  let targetPort = 80;
  try {
    const u = new URL(targetUrl);
    targetHost = u.hostname;
    targetPort = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  } catch (_) {
    targetHost = (req.headers.host as string) || '';
  }

  // Domain routing: match domain to tag
  let tag: string | null = null;
  if (domainRouter) {
    tag = domainRouter.match(targetHost);
  }

  // ACL check (Phase 3): deny access to blocked hosts/ports
  if (clientManager.acl && !clientManager.acl.check(null, targetHost, 'http', targetPort, req.socket?.remoteAddress || '')) {
    logger.warn({ targetHost, ip: req.socket?.remoteAddress }, 'ACL denied HTTP request');
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access denied by ACL');
    return;
  }

  // Check cache for GET requests
  let cacheKey: string | null = null;
  if (cache && req.method === 'GET') {
    cacheKey = cache.makeKey(req.method, targetUrl, req.headers);
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        const headers: HeadersLike = {
          ...cached.headers,
          'x-cache': 'HIT',
          'x-cache-age': String(Math.floor(cached.age / 1000)),
        };
        res.writeHead(cached.statusCode, headers as http.OutgoingHttpHeaders);
        res.end(cached.data);
        return;
      }
    }
  }

  // Select client with optional tag
  // Per-password route (tag / forced node UUID / strategy) wins over the
  // domain-rule tag when both are present (issue #53).
  const client = clientManager.selectClient(route.tag || tag, {
    clientId: route.clientId || null,
    strategy: route.strategy || null,
  });
  if (!client) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('No available proxy clients');
    return;
  }

  // Check bandwidth limit (per selected client + global)
  const estimateSize = parseInt((req.headers['content-length'] as string) || '0', 10) + 2048;
  const bw = clientManager.bandwidthLimiter;
  if (bw && (!bw.check(client.id, estimateSize) || !bw.check('global', estimateSize))) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
    res.end('Rate limited: bandwidth exceeded');
    return;
  }

  // Check slot
  if (client.pendingRequests.size >= (config.client?.max_concurrent || 100)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Client busy');
    return;
  }

  const requestId = uuidv4();
  const chunks: Buffer[] = [];
  const startTime = Date.now();

  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('base64');
    let targetUrl2 = req.url || '';
    if (!targetUrl2.startsWith('http://') && !targetUrl2.startsWith('https://')) {
      targetUrl2 = `http://${req.headers.host || 'unknown'}${targetUrl2}`;
    }

    const requestMsg: Record<string, unknown> = {
      type: 'request',
      id: requestId,
      method: req.method,
      url: targetUrl2,
      headers: sanitizeHeaders(req.headers),
      body: body || '',
    };

    const timeout = setTimeout(() => {
      clientManager.pendingRequests.delete(requestId);
      client.pendingRequests.delete(requestId);
      clientManager.trackError(client.id, 'timeout');
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Proxy request timeout');
      }
    }, config.client.request_timeout);

    // Override resolve to handle caching
    // msg = response headers; bodyBuf = complete body (passed by mux path when data collected)
    const originalResolve = (msg: Record<string, unknown>, bodyBuf?: Buffer) => {
      if (cacheKey && cache && Number(msg.statusCode) < 400) {
        const data = bodyBuf || (typeof msg.body === 'string' ? Buffer.from(msg.body, 'base64') : null);
        if (data && data.length > 0) {
          cache.set(cacheKey, data, Number(msg.statusCode) || 200, (msg.headers as HeadersLike) || {});
        }
      }
    };

    clientManager.pendingRequests.set(requestId, {
      resolve: null,
      reject: null,
      timeout,
      res,
      clientId: client.id,
      startTime,
      _onResponse: originalResolve,
      _audit: {
        method: req.method,
        url: targetUrl2,
        host: targetHost,
        protocol: 'http',
        clientTags: client.tags,
        clientId: client.id,
      },
    });
    client.pendingRequests.add(requestId);
    clientManager.trackRequest('http', 0, 0, client.id);

    // Send request via StreamMux (priority: API calls = 0-50, normal = 128, bulk = 200+)
    const priority = req.method === 'GET' ? 128 : 50;
    const stream = client.mux ? client.mux.createStream(priority) : null;

    if (stream) {
      // Use StreamMux - send request as stream headers + data
      stream.sendHeaders(
        {
          type: 'request',
          id: requestId,
          method: req.method,
          url: targetUrl2,
          headers: sanitizeHeaders(req.headers),
        },
        !body
      );

      if (body) {
        stream.sendData(Buffer.from(body, 'base64'), true);
      }

      // Handle response via stream
      stream._onHeaders = (headers) => {
        clearTimeout(timeout);
        // Cache response
        if (cacheKey && cache && Number(headers.statusCode) < 400) {
          // Will cache when data is complete
        }
      };

      stream._onData = (_chunk) => {
        // Response data being received - stored in stream
      };

      stream._onEnd = () => {
        // Response complete - handled by ws-server
      };

      stream._onError = (reason) => {
        clearTimeout(timeout);
        clientManager.pendingRequests.delete(requestId);
        client.pendingRequests.delete(requestId);
        clientManager.trackError(client.id, 'stream_error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Stream error: ' + reason);
        }
      };
    } else {
      // Fallback to legacy JSON
      client.ws.send(JSON.stringify(requestMsg), (err) => {
        if (err) {
          clearTimeout(timeout);
          clientManager.pendingRequests.delete(requestId);
          client.pendingRequests.delete(requestId);
          clientManager.trackError(client.id, 'send_error');
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Proxy error: ' + err.message);
          }
        }
      });
    }
  });

  req.on('error', (err) => {
    logger.error({ error: err.message }, 'HTTP request error');
  });
}

function handleConnect(
  req: IncomingMessage,
  socket: ConnectTarget,
  clientManager: ClientManager,
  authManager: HttpAuthManagerLike,
  config: ServerConfig,
  logger: AppLogger,
  domainRouter: DomainRouter | null,
  head: Buffer | PluginManagerLike | null | undefined,
  pluginManager?: PluginManagerLike | null
) {
  // The socket handed to the 'connect' event is not managed by the http server
  // internals anymore; without an error listener an ECONNRESET from the client
  // would crash the whole process as an uncaught exception.
  socket.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ error: message }, 'CONNECT socket error');
  });

  const route = checkProxyAuth(req, authManager, logger);
  if (!route) {
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Node-Proxy"\r\n\r\n');
    return;
  }

  // Plugin hook: onRequest for CONNECT tunnels
  runPluginHook(pluginManager, 'onRequest', {
    req,
    socket,
    clientManager,
    method: req.method,
    url: req.url,
    headers: req.headers,
    ip: clientIp(req),
    timestamp: Date.now(),
  });

  const hostPort = String(req.url || '').split(':');
  const host = hostPort[0] || '';
  const port = parseInt(hostPort[1] || '', 10) || 443;

  // ACL check for CONNECT tunnels
  if (clientManager.acl && !clientManager.acl.check(null, host, 'http', port, req.socket?.remoteAddress || '')) {
    logger.warn({ targetHost: host, targetPort: port, ip: req.socket?.remoteAddress }, 'ACL denied CONNECT');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  // Domain routing
  let tag: string | null = null;
  if (domainRouter) {
    tag = domainRouter.match(host);
  }

  // Per-password route (tag / forced node UUID / strategy) wins over the
  // domain-rule tag when both are present (issue #53).
  const client = clientManager.selectClient(route.tag || tag, {
    clientId: route.clientId || null,
    strategy: route.strategy || null,
  });
  if (!client) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  // Check slot
  if (client.pendingTunnels.size >= (config.client?.max_concurrent || 100)) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nClient busy\r\n\r\n');
    return;
  }

  const tunnelId = uuidv4();
  const startTime = Date.now();

  const requestMsg = { type: 'tunnel_open', id: tunnelId, host, port };

  const timeout = setTimeout(() => {
    clientManager.pendingTunnels.delete(tunnelId);
    client.pendingTunnels.delete(tunnelId);
    // NOTE: not feeding the circuit breaker here — a tunnel_timeout is a
    // target-level failure, not a node-health signal.  Feeding the breaker
    // also made SOCKS5 unreachable via this client (same breaker).
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
    }
  }, config.client.tunnel_timeout);

  clientManager.pendingTunnels.set(tunnelId, {
    type: 'http',
    socket: socket as unknown as NetSocket,
    client,
    timeout,
    startTime,
    head: Buffer.isBuffer(head) ? head : Buffer.alloc(0),
    ip: clientIp(req),
    host,
    port,
  });
  client.pendingTunnels.add(tunnelId);
  clientManager.trackTunnel(client.id);

  client.ws.send(JSON.stringify(requestMsg), (err) => {
    if (err) {
      clearTimeout(timeout);
      clientManager.pendingTunnels.delete(tunnelId);
      client.pendingTunnels.delete(tunnelId);
      clientManager.trackError(client.id, 'tunnel_send_error');
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    }
  });
}

