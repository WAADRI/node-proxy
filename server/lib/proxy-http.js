// =============================================================================
// HTTP Proxy - HTTP/HTTPS CONNECT proxy with authentication
// v2.1 - Uses router, bandwidth limiter, circuit breaker
// =============================================================================
'use strict';

const http = require('http');
const { v4: uuidv4 } = require('uuid');

function createHttpProxy(clientManager, authManager, config, logger, domainRouter, cache, pluginManager) {
  const server = http.createServer((req, res) => {
    if (req.method === 'CONNECT') {
      handleConnect(req, res, clientManager, authManager, config, logger, domainRouter, pluginManager);
      return;
    }
    handleHttpRequest(req, res, clientManager, authManager, config, logger, domainRouter, cache, pluginManager);
  });

  server.on('connect', (req, socket, head) => {
    handleConnect(req, socket, clientManager, authManager, config, logger, domainRouter, head, pluginManager);
  });

  return server;
}

// Fire-and-forget plugin hook execution (never blocks or breaks the proxy path)
function runPluginHook(pluginManager, hook, context) {
  if (!pluginManager || typeof pluginManager.executeHook !== 'function') return;
  Promise.resolve(pluginManager.executeHook(hook, context)).catch(() => {});
}

function checkProxyAuth(req, authManager, logger) {
  const authHeader = req.headers['proxy-authorization'];
  if (!authManager.validateProxyAuth(authHeader)) {
    logger.warn({ ip: req.socket.remoteAddress, method: req.method, url: req.url }, 'Proxy auth failed');
    return false;
  }
  return true;
}

function handleHttpRequest(req, res, clientManager, authManager, config, logger, domainRouter, cache, pluginManager) {
  if (!checkProxyAuth(req, authManager, logger)) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Node-Proxy"', 'Content-Type': 'text/plain' });
    res.end('Proxy authentication required');
    return;
  }

  // Plugin hook: onRequest
  runPluginHook(pluginManager, 'onRequest', {
    req, res,
    clientManager,
    method: req.method,
    url: req.url,
    headers: req.headers,
    ip: req.socket?.remoteAddress || '',
    timestamp: Date.now(),
  });

  // Plugin hook: onResponse (when response finishes)
  res.on('finish', () => {
    runPluginHook(pluginManager, 'onResponse', {
      req,
      res,
      clientManager,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: 0,
      timestamp: Date.now(),
    });
  });

  // Extract target URL for domain routing
  let targetUrl = req.url;
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = `http://${req.headers.host || 'unknown'}${targetUrl}`;
  }
  let targetHost = '';
  let targetPort = 80;
  try {
    const u = new URL(targetUrl);
    targetHost = u.hostname;
    targetPort = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  } catch (_) { targetHost = req.headers.host || ''; }

  // Domain routing: match domain to tag
  let tag = null;
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
  let cacheKey = null;
  if (cache && req.method === 'GET') {
    cacheKey = cache.makeKey(req.method, targetUrl, req.headers);
    const cached = cache.get(cacheKey);
    if (cached) {
      const headers = { ...cached.headers, 'x-cache': 'HIT', 'x-cache-age': String(Math.floor(cached.age / 1000)) };
      res.writeHead(cached.statusCode, headers);
      res.end(cached.data);
      return;
    }
  }

  // Select client with optional tag
  const client = clientManager.selectClient(tag);
  if (!client) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('No available proxy clients');
    return;
  }

  // Check bandwidth limit (per selected client + global)
  const estimateSize = parseInt(req.headers['content-length'] || '0', 10) + 2048;
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
  const chunks = [];
  const startTime = Date.now();
  let timedOut = false;

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('base64');
    let targetUrl = req.url;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `http://${req.headers.host || 'unknown'}${targetUrl}`;
    }

    const requestMsg = {
      type: 'request',
      id: requestId,
      method: req.method,
      url: targetUrl,
      headers: sanitizeHeaders(req.headers),
      body: body || '',
    };

    const timeout = setTimeout(() => {
      timedOut = true;
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
    const originalResolve = (msg, bodyBuf) => {
      if (cacheKey && cache && msg.statusCode < 400) {
        const data = bodyBuf || (msg.body ? Buffer.from(msg.body, 'base64') : null);
        if (data && data.length > 0) {
          cache.set(cacheKey, data, msg.statusCode, msg.headers);
        }
      }
    };

    clientManager.pendingRequests.set(requestId, {
      resolve: null, reject: null, timeout, res,
      clientId: client.id, startTime,
      _onResponse: originalResolve,
      _audit: {
        method: req.method,
        url: targetUrl,
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
      stream.sendHeaders({
        type: 'request',
        id: requestId,
        method: req.method,
        url: targetUrl,
        headers: sanitizeHeaders(req.headers),
      }, !body);

      if (body) {
        stream.sendData(Buffer.from(body, 'base64'), true);
      }

      // Handle response via stream
      stream._onHeaders = (headers) => {
        clearTimeout(timeout);
        // Cache response
        if (cacheKey && cache && headers.statusCode < 400) {
          // Will cache when data is complete
        }
      };

      stream._onData = (chunk) => {
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

function handleConnect(req, socket, clientManager, authManager, config, logger, domainRouter, head, pluginManager) {
  // The socket handed to the 'connect' event is not managed by the http server
  // internals anymore; without an error listener an ECONNRESET from the client
  // would crash the whole process as an uncaught exception.
  socket.on('error', (err) => {
    logger.warn({ error: err.message }, 'CONNECT socket error');
  });

  if (!checkProxyAuth(req, authManager, logger)) {
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Node-Proxy"\r\n\r\n');
    return;
  }

  // Plugin hook: onRequest for CONNECT tunnels
  runPluginHook(pluginManager, 'onRequest', {
    req, socket,
    clientManager,
    method: req.method,
    url: req.url,
    headers: req.headers,
    ip: req.socket?.remoteAddress || '',
    timestamp: Date.now(),
  });

  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;

  // ACL check for CONNECT tunnels
  if (clientManager.acl && !clientManager.acl.check(null, host, 'http', port, req.socket?.remoteAddress || '')) {
    logger.warn({ targetHost: host, targetPort: port, ip: req.socket?.remoteAddress }, 'ACL denied CONNECT');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  // Domain routing
  let tag = null;
  if (domainRouter) {
    tag = domainRouter.match(host);
  }

  const client = clientManager.selectClient(tag);
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
    clientManager.trackError(client.id, 'tunnel_timeout');
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
    }
  }, config.client.tunnel_timeout);

  clientManager.pendingTunnels.set(tunnelId, {
    type: 'http', socket, client, timeout, startTime,
    head: head || Buffer.alloc(0),
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

function sanitizeHeaders(headers) {
  const sanitized = { ...headers };
  delete sanitized['proxy-authorization'];
  delete sanitized['proxy-connection'];
  delete sanitized['connection'];
  return sanitized;
}

module.exports = { createHttpProxy };