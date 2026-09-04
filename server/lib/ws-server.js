// =============================================================================
// WebSocket Server v3.0 - Client connection management with StreamMux
// Phase 4: WebSocket 连接复用
// =============================================================================
'use strict';

const { WebSocketServer } = require('ws');
const { StreamMux, FRAME_TYPE, DEFAULT_PRIORITY } = require('./stream-mux');

function setupClientWebSocket(httpServer, clientManager, authManager, config, logger) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    let clientId = null;
    let authenticated = false;
    // Read the real client IP from nginx proxy headers when available;
    // otherwise fall back to the raw TCP connection address (Docker gateway / nginx IP).
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.headers['x-real-ip']
                  || req.socket.remoteAddress;

    // Create StreamMux for this client
    const mux = new StreamMux(ws, {
      logger,
      initialWindow: config.mux?.initial_window || 65536,
      connectionWindow: config.mux?.connection_window || 1048576,
    });

    // Store mux on client for proxy handlers to use
    ws.mux = mux;

    // Handle incoming streams from client
    mux.onStream((stream) => {
      if (!authenticated) {
        stream.reset(1);
        return;
      }

      const type = stream.headers?.type || '';

      if (type === 'response' || stream.headers?.statusCode) {
        handleClientResponse(clientManager, stream, logger);
        return;
      }

      if (type === 'tunnel_ready') {
        handleTunnelReady(clientManager, stream, logger);
        return;
      }

      if (type === 'tunnel_data') {
        handleTunnelData(clientManager, stream, logger);
        return;
      }

      if (type === 'tunnel_close') {
        handleTunnelClose(clientManager, stream, logger);
        return;
      }

      if (type === 'tunnel_error') {
        handleTunnelError(clientManager, stream, logger);
        return;
      }

      // Legacy JSON message handling
      handleLegacyStream(clientManager, stream, logger);
    });

    // Also handle legacy JSON messages (backward compatibility)
    // NOTE: ws 8.x passes text frames as Buffer with isBinary=false
    ws.on('message', (raw, isBinary) => {
      if (isBinary === true) {
        return; // Binary frames handled by StreamMux
      }

      try {
        const msg = JSON.parse(raw.toString());

        if (!authenticated) {
          if (msg.type === 'auth') {
            if (authManager.validateClientToken(msg.token)) {
              authenticated = true;
              ws.send(JSON.stringify({ type: 'auth_ok' }));
            } else {
              logger.warn({ ip: clientIp }, 'Client auth failed - invalid token');
              ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
              ws.close(4001, 'Auth failed');
            }
          }
          return;
        }

        switch (msg.type) {
          case 'info': {
            const info = msg.info || {};
            info.ip = clientIp;
            clientId = clientManager.add(ws, info);
            // Attach StreamMux to the client so proxy handlers can use multiplexing
            // Only when the client declares support (backward compatible with JSON-only clients)
            const c = clientManager.getById(clientId);
            if (c) c.mux = info.supportsMux ? ws.mux : null;
            ws.clientId = clientId;
            ws.send(JSON.stringify({ type: 'info_ok', clientId }));
            logger.info({ clientId, hostname: info.hostname, tags: info.tags, ip: clientIp, mux: !!info.supportsMux }, 'Client registered');
            break;
          }

          case 'response':
            handleClientResponseLegacy(clientManager, msg, logger);
            break;

          case 'tunnel_ready':
            handleTunnelReadyLegacy(clientManager, msg, logger);
            break;

          case 'tunnel_data':
            handleTunnelDataLegacy(clientManager, msg, logger);
            break;

          case 'tunnel_close':
            handleTunnelCloseLegacy(clientManager, msg, logger);
            break;

          case 'tunnel_error':
            handleTunnelErrorLegacy(clientManager, msg, logger);
            break;

          case 'udp_data_response':
            // UDP response from client, relay back to SOCKS5 UDP client
            if (clientManager.onUdpData) {
              try { clientManager.onUdpData(msg); } catch (_) {}
            }
            break;

          case 'heartbeat':
          case 'pong':
            clientManager.recordPong(clientId);
            break;

          case 'stats':
            if (clientId) {
              const c = clientManager.getById(clientId);
              if (c && msg.stats) Object.assign(c.stats, msg.stats);
            }
            break;

          default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
        }
      } catch (err) {
        logger.error({ error: err.message }, 'Invalid message from client');
      }
    });

    ws.on('close', (code, reason) => {
      mux.destroy();
      if (clientId) clientManager.remove(clientId, `ws_close:${code}`);
    });

    ws.on('error', (err) => {
      logger.error({ error: err.message, clientId }, 'Client WebSocket error');
      mux.destroy();
      if (clientId) clientManager.remove(clientId, 'ws_error');
    });

    // Heartbeat via StreamMux
    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        mux.ping((rtt) => {
          const c = clientManager.getById(clientId);
          if (c) c.rtt = rtt;
        });
      }
    }, 30000);

    ws.on('close', () => { clearInterval(pingInterval); mux.destroy(); });
    ws.on('error', () => { clearInterval(pingInterval); mux.destroy(); });
  });

  return wss;
}

// =============================================================================
// Stream-based handlers (new protocol)
// =============================================================================

function handleClientResponse(clientManager, stream, logger) {
  const headers = stream.headers || {};
  const msgId = headers.id || stream.id;

  const p = clientManager.pendingRequests.get(msgId);
  if (!p) return;

  clearTimeout(p.timeout);
  clientManager.pendingRequests.delete(msgId);

  // Cache response if applicable
  if (p._onResponse) {
    try { p._onResponse(headers); } catch (_) {}
  }

  // Audit logging
  if (clientManager.audit && p._audit) {
    try {
      clientManager.audit.logRequest({
        ...p._audit,
        requestId: msgId,
        status: headers.statusCode >= 400 ? 'error' : 'success',
        statusCode: headers.statusCode || 0,
        duration: Date.now() - p.startTime,
        error: headers.error || '',
      });
    } catch (_) {}
  }

  // Find client and remove from pending
  for (const [, c] of clientManager.clients) {
    if (c.pendingRequests.has(msgId)) {
      c.pendingRequests.delete(msgId);
      break;
    }
  }

  const { res, clientId, startTime } = p;
  const duration = startTime ? Date.now() - startTime : 0;

  if (res && !res.headersSent) {
    const respHeaders = headers.headers || {};
    delete respHeaders['transfer-encoding'];
    delete respHeaders['connection'];
    delete respHeaders['proxy-connection'];

    const statusCode = headers.statusCode || 200;

    // Collect data from the stream
    const chunks = [];
    let endFired = false;
    stream._onData = (chunk) => {
      chunks.push(chunk);
    };
    stream._onEnd = () => {
      if (endFired) return; // Guard against duplicate end frames (double responses)
      endFired = true;
      const body = Buffer.concat(chunks);
      // Cache the complete response (body only available after DATA frames)
      if (p._onResponse) {
        try { p._onResponse(headers, body); } catch (_) {}
      }
      // Bandwidth limit on response body (downstream)
      const bw = clientManager.bandwidthLimiter;
      if (bw && !bw.check(clientId, body.length)) {
        if (!res.headersSent) {
          res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
          res.end('Rate limited: bandwidth exceeded');
        }
        clientManager.trackRequest('http', 429, duration, clientId);
        clientManager.trackError(clientId, 'bandwidth');
        return;
      }
      res.writeHead(statusCode, headers.statusMessage || '', respHeaders);
      res.end(body);

      clientManager.trackRequest('http', statusCode, duration, clientId);
      // Count upstream failures (>=500 or explicit error) as circuit breaker failures
      if (statusCode >= 500 || headers.error) {
        clientManager.trackError(clientId, 'upstream_' + statusCode);
      } else {
        clientManager.trackSuccess(clientId);
      }
      if (body.length > 0) clientManager.trackBytes(clientId, 0, body.length);
    };
    stream._onError = (reason) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + reason);
      }
    };

    // If the stream already has data, handle it
    if (stream._bufferedData && stream._bufferedData.length > 0) {
      for (const chunk of stream._bufferedData) {
        chunks.push(chunk);
      }
      stream._bufferedData = [];
    }
  }
}

// Record a tunnel (HTTPS CONNECT / SOCKS5) into the request log once it closes
function recordTunnelLog(clientManager, p) {
  const hub = clientManager && clientManager.requestLog;
  if (!hub || !p) return;
  const endTs = Date.now();
  try {
    hub.record({
      kind: 'tunnel',
      ts: p.startTime || endTs,
      ip: p.ip || '',
      method: 'CONNECT',
      url: (p.host || '') + (p.port ? ':' + p.port : ''),
      status: 0,
      ms: Math.max(0, endTs - (p.startTime || endTs)),
    });
  } catch (_) {}
}

function handleTunnelReady(clientManager, stream, logger) {
  const headers = stream.headers || {};
  const msgId = headers.id || stream.id;

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p) return;

  clearTimeout(p.timeout);
  p.timeout = null;

  const { socket, head, type, client, startTime } = p;
  const duration = startTime ? Date.now() - startTime : 0;

  if (socket.write && !socket.destroyed) {
    if (type === 'socks5') {
      socket.write(encodeSocks5Reply(0x00));
    } else {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) socket.write(head);
    }
  }

  clientManager.trackSuccess(client?.id);

  // Forward tunnel data through the stream
  socket.on('data', (data) => {
    if (stream.state !== 'closed' && stream.state !== 'half_closed_local') {
      stream.sendData(data);
      clientManager.trackBytes(client?.id, data.length, 0);
    }
  });

  socket.on('close', () => {
    recordTunnelLog(clientManager, p);
    stream.close();
    clientManager.pendingTunnels.delete(msgId);
    if (client) client.pendingTunnels.delete(msgId);
  });

  socket.on('error', () => {});

  // Forward stream data back to the socket
  stream._onData = (chunk) => {
    if (socket && !socket.destroyed) {
      socket.write(chunk);
      clientManager.trackBytes(client?.id, 0, chunk.length);
    }
  };
  stream._onEnd = () => {
    if (socket && !socket.destroyed) socket.end();
  };
  stream._onError = (reason) => {
    if (socket && !socket.destroyed) {
      try {
        if (p.type === 'socks5') socket.write(encodeSocks5Reply(0x01));
        else socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.end();
      } catch (_) {}
    }
    clientManager.pendingTunnels.delete(msgId);
    if (client) client.pendingTunnels.delete(msgId);
  };

  p.ready = true;
}

function handleTunnelData(clientManager, stream, logger) {
  const headers = stream.headers || {};
  const msgId = headers.id || stream.id;

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p || !p.socket || p.socket.destroyed) return;

  // Collect data from the stream
  stream._onData = (chunk) => {
    p.socket.write(chunk);
    clientManager.trackBytes(p.client?.id, 0, chunk.length);
  };
}

function handleTunnelClose(clientManager, stream, logger) {
  const headers = stream.headers || {};
  const msgId = headers.id || stream.id;

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p) return;
  if (p.socket && !p.socket.destroyed) p.socket.end();
  if (p.timeout) clearTimeout(p.timeout);
  clientManager.pendingTunnels.delete(msgId);
  if (p.client) p.client.pendingTunnels.delete(msgId);
}

function handleTunnelError(clientManager, stream, logger) {
  const headers = stream.headers || {};
  const msgId = headers.id || stream.id;

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p) return;
  if (p.timeout) clearTimeout(p.timeout);

  if (p.socket && !p.socket.destroyed) {
    try {
      if (p.type === 'socks5') p.socket.write(encodeSocks5Reply(0x01));
      else p.socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      p.socket.end();
    } catch (_) {}
  }

  clientManager.trackError(p.client?.id, 'tunnel_error');
  clientManager.pendingTunnels.delete(msgId);
  if (p.client) p.client.pendingTunnels.delete(msgId);
}

function handleLegacyStream(clientManager, stream, logger) {
  // Unknown stream type - just close it
  stream.close();
}

// =============================================================================
// Legacy JSON handlers (backward compatibility)
// =============================================================================

function handleClientResponseLegacy(clientManager, msg, logger) {
  const p = clientManager.pendingRequests.get(msg.id);
  if (!p) return;
  clearTimeout(p.timeout);
  clientManager.pendingRequests.delete(msg.id);

  if (p._onResponse) {
    try { p._onResponse(msg); } catch (_) {}
  }

  if (clientManager.audit && p._audit) {
    try {
      clientManager.audit.logRequest({
        ...p._audit,
        requestId: msg.id,
        status: msg.statusCode >= 400 ? 'error' : 'success',
        statusCode: msg.statusCode || 0,
        duration: Date.now() - p.startTime,
        error: msg.error || '',
      });
    } catch (_) {}
  }

  for (const [, c] of clientManager.clients) {
    if (c.pendingRequests.has(msg.id)) {
      c.pendingRequests.delete(msg.id);
      break;
    }
  }

  const { res, clientId, startTime } = p;
  const duration = startTime ? Date.now() - startTime : 0;

  if (res && !res.headersSent) {
    const headers = msg.headers || {};
    delete headers['transfer-encoding'];
    delete headers['connection'];
    delete headers['proxy-connection'];

    const body = msg.body ? Buffer.from(msg.body, 'base64') : null;
    res.writeHead(msg.statusCode || 200, msg.statusMessage || '', headers);
    res.end(body);

    clientManager.trackRequest('http', msg.statusCode || 200, duration, clientId);
    // Count upstream failures as circuit breaker failures
    if ((msg.statusCode || 200) >= 500 || msg.error) {
      clientManager.trackError(clientId, 'upstream_' + (msg.statusCode || 0));
    } else {
      clientManager.trackSuccess(clientId);
    }
    if (body) clientManager.trackBytes(clientId, 0, body.length);
  }
}

function handleTunnelReadyLegacy(clientManager, msg, logger) {
  const p = clientManager.pendingTunnels.get(msg.id);
  if (!p) return;
  clearTimeout(p.timeout);
  p.timeout = null;

  const { socket, head, type, client, startTime } = p;
  const duration = startTime ? Date.now() - startTime : 0;

  if (socket.write && !socket.destroyed) {
    if (type === 'socks5') {
      socket.write(encodeSocks5Reply(0x00));
    } else {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) socket.write(head);
    }
  }

  clientManager.trackSuccess(client?.id);

  socket.on('data', (data) => {
    if (client && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify({ type: 'tunnel_data', id: msg.id, data: data.toString('base64') }));
      clientManager.trackBytes(client.id, data.length, 0);
    }
  });

  socket.on('close', () => {
    recordTunnelLog(clientManager, p);
    if (client && client.ws.readyState === 1) {
      try { client.ws.send(JSON.stringify({ type: 'tunnel_close', id: msg.id })); } catch (_) {}
    }
    clientManager.pendingTunnels.delete(msg.id);
    if (client) client.pendingTunnels.delete(msg.id);
  });

  socket.on('error', () => {});

  p.ready = true;
}

function handleTunnelDataLegacy(clientManager, msg, logger) {
  const p = clientManager.pendingTunnels.get(msg.id);
  if (!p || !p.socket || p.socket.destroyed) return;
  const data = Buffer.from(msg.data, 'base64');
  p.socket.write(data);
  clientManager.trackBytes(p.client?.id, 0, data.length);
}

function handleTunnelCloseLegacy(clientManager, msg, logger) {
  const p = clientManager.pendingTunnels.get(msg.id);
  if (!p) return;
  if (p.socket && !p.socket.destroyed) p.socket.end();
  if (p.timeout) clearTimeout(p.timeout);
  clientManager.pendingTunnels.delete(msg.id);
  if (p.client) p.client.pendingTunnels.delete(msg.id);
}

function handleTunnelErrorLegacy(clientManager, msg, logger) {
  const p = clientManager.pendingTunnels.get(msg.id);
  if (!p) return;
  if (p.timeout) clearTimeout(p.timeout);

  if (p.socket && !p.socket.destroyed) {
    try {
      if (p.type === 'socks5') p.socket.write(encodeSocks5Reply(0x01));
      else p.socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      p.socket.end();
    } catch (_) {}
  }

  clientManager.trackError(p.client?.id, 'tunnel_error');
  clientManager.pendingTunnels.delete(msg.id);
  if (p.client) p.client.pendingTunnels.delete(msg.id);
}

function encodeSocks5Reply(replyCode) {
  const buf = Buffer.alloc(10);
  buf[0] = 0x05; buf[1] = replyCode; buf[2] = 0x00; buf[3] = 0x01;
  for (let i = 4; i < 10; i++) buf[i] = 0x00;
  return buf;
}

module.exports = { setupClientWebSocket };