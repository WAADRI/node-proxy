// =============================================================================
// WebSocket Server v3.0 - Client connection management with StreamMux
// Phase 4: WebSocket 连接复用
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; loaded by
// require('./lib/ws-server.ts') under Node >= 24 type stripping.
// =============================================================================

import type { Server as HttpServer, OutgoingHttpHeaders } from 'http';
import type { Socket as NetSocket } from 'net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { StreamMux, type MuxStreamLike } from './stream-mux.ts';
import type { ClientManager, ClientInfo, PendingRecord } from './client-manager.ts';
import type { ServerConfig } from './config.ts';
import type { AppLogger } from './logger.ts';

interface AuthManagerLike {
  validateClientToken(token: string): boolean;
}

type WsWithMux = WebSocket & { mux?: StreamMux; clientId?: string };

interface ClientMessage {
  type?: string;
  token?: string;
  info?: ClientInfo;
  stats?: Record<string, unknown>;
  id?: string;
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, unknown>;
  body?: string;
  error?: string;
  [key: string]: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

// Write to a proxied socket only while it is still open. After socket.end()
// (or destroy) a late write - e.g. a tunnel timeout callback racing a client
// disconnect, or a duplicate error reply - would emit 'write after end' on
// the socket error handler and show up as noisy SOCKS5 socket errors.
function safeWrite(socket: NetSocket | null | undefined, data: Buffer | string): boolean {
  if (!socket || socket.destroyed || socket.writableEnded) return false;
  try {
    socket.write(data);
    return true;
  } catch (_) {
    return false;
  }
}

export function setupClientWebSocket(
  httpServer: HttpServer,
  clientManager: ClientManager,
  authManager: AuthManagerLike,
  config: ServerConfig,
  logger: AppLogger
) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (rawWs, req) => {
    const ws = rawWs as WsWithMux;
    let clientId: string | null = null;
    let authenticated = false;
    // Read the real client IP from nginx proxy headers when available;
    // otherwise fall back to the raw TCP connection address (Docker gateway / nginx IP).
    const clientIp =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string | undefined) ||
      req.socket.remoteAddress ||
      '';

    // Create StreamMux for this client
    const mux = new StreamMux(ws, {
      logger,
      initialWindow: config.mux?.initial_window || 65536,
      connectionWindow: config.mux?.connection_window || 1048576,
    });

    // Store mux on client for proxy handlers to use
    ws.mux = mux;

    // Handle incoming streams from client
    mux.onStream((stream: MuxStreamLike) => {
      if (!authenticated) {
        stream.reset(1);
        return;
      }

      const type = asString(stream.headers?.type);

      if (type === 'response' || asNumber(stream.headers?.statusCode) > 0) {
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
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary === true) {
        return; // Binary frames handled by StreamMux
      }

      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;

        if (!authenticated) {
          if (msg.type === 'auth') {
            if (authManager.validateClientToken(asString(msg.token))) {
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
            const info: ClientInfo = { ...asRecord(msg.info) };
            info.ip = clientIp;
            clientId = clientManager.add(ws, info);
            // Attach StreamMux to the client so proxy handlers can use multiplexing
            // Only when the client declares support (backward compatible with JSON-only clients)
            const c = clientManager.getById(clientId);
            if (c) c.mux = info.supportsMux ? ws.mux : null;
            ws.clientId = clientId;
            ws.send(JSON.stringify({ type: 'info_ok', clientId }));
            logger.info(
              { clientId, hostname: info.hostname, tags: info.tags, ip: clientIp, mux: !!info.supportsMux },
              'Client registered'
            );
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
              try {
                clientManager.onUdpData(asRecord(msg));
              } catch (_) {
                // ignore
              }
            }
            break;

          case 'heartbeat':
          case 'pong':
            if (clientId) clientManager.recordPong(clientId);
            break;

          case 'stats':
            if (clientId) {
              const c = clientManager.getById(clientId);
              const stats = asRecord(msg.stats);
              if (c && Object.keys(stats).length > 0) Object.assign(c.stats, stats);
            }
            break;

          // Network test (issue #31): node-side execution reports
          case 'net_test_progress':
            if (clientManager.netTest) clientManager.netTest.onClientProgress(clientId, asRecord(msg));
            break;

          case 'net_test_done':
            if (clientManager.netTest) clientManager.netTest.onClientDone(clientId, asRecord(msg));
            break;

          default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ error: message }, 'Invalid message from client');
      }
    });

    ws.on('close', (code: number, _reason: string) => {
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
          const c = clientId ? clientManager.getById(clientId) : null;
          if (c) c.rtt = rtt;
        });
      }
    }, 30000);

    ws.on('close', () => {
      clearInterval(pingInterval);
      mux.destroy();
    });
    ws.on('error', () => {
      clearInterval(pingInterval);
      mux.destroy();
    });
  });

  return wss;
}

// =============================================================================
// Stream-based handlers (new protocol)
// =============================================================================

function handleClientResponse(clientManager: ClientManager, stream: MuxStreamLike, _logger: AppLogger) {
  const headers = asRecord(stream.headers);
  const msgId = asString(headers.id) || String(stream.id);

  const p = clientManager.pendingRequests.get(msgId);
  if (!p) return;

  if (p.timeout) clearTimeout(p.timeout);
  clientManager.pendingRequests.delete(msgId);

  // Cache response if applicable
  if (p._onResponse) {
    try {
      p._onResponse(headers);
    } catch (_) {
      // ignore
    }
  }

  // Audit logging
  if (clientManager.audit && p._audit) {
    try {
      clientManager.audit.logRequest({
        ...p._audit,
        requestId: msgId,
        status: asNumber(headers.statusCode) >= 400 ? 'error' : 'success',
        statusCode: asNumber(headers.statusCode),
        duration: p.startTime ? Date.now() - p.startTime : 0,
        error: asString(headers.error),
      });
    } catch (_) {
      // ignore
    }
  }

  // Find client and remove from pending
  for (const c of clientManager.clients.values()) {
    if (c.pendingRequests.has(msgId)) {
      c.pendingRequests.delete(msgId);
      break;
    }
  }

  const { res, clientId: recClientId, startTime } = p;
  const duration = startTime ? Date.now() - startTime : 0;

  if (res && !res.headersSent) {
    const respHeaders = asRecord(headers.headers);
    delete respHeaders['transfer-encoding'];
    delete respHeaders['connection'];
    delete respHeaders['proxy-connection'];

    const statusCode = asNumber(headers.statusCode) || 200;

    // Collect data from the stream
    const chunks: Buffer[] = [];
    let endFired = false;
    stream._onData = (chunk: Buffer) => {
      chunks.push(chunk);
    };
    stream._onEnd = () => {
      if (endFired) return; // Guard against duplicate end frames (double responses)
      endFired = true;
      const body = Buffer.concat(chunks);
      // Cache the complete response (body only available after DATA frames)
      if (p._onResponse) {
        try {
          p._onResponse(headers, body);
        } catch (_) {
          // ignore
        }
      }
      // Bandwidth limit on response body (downstream)
      const bw = clientManager.bandwidthLimiter;
      if (bw && !bw.check(recClientId || '', body.length)) {
        if (!res.headersSent) {
          res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
          res.end('Rate limited: bandwidth exceeded');
        }
        clientManager.trackRequest('http', 429, duration, recClientId);
        clientManager.trackError(recClientId, 'bandwidth');
        return;
      }
      const statusMessage = asString(headers.statusMessage);
      res.writeHead(statusCode, statusMessage, respHeaders as OutgoingHttpHeaders);
      res.end(body);

      clientManager.trackRequest('http', statusCode, duration, recClientId);
      // Count upstream failures (>=500 or explicit error) as circuit breaker failures
      if (statusCode >= 500 || headers.error) {
        clientManager.trackError(recClientId, 'upstream_' + statusCode);
      } else {
        clientManager.trackSuccess(recClientId);
      }
      if (body.length > 0) clientManager.trackBytes(recClientId, 0, body.length);
    };
    stream._onError = (reason: string | number) => {
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
function recordTunnelLog(clientManager: ClientManager, p: PendingRecord) {
  const hub = clientManager.requestLog;
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
  } catch (_) {
    // ignore
  }
}

// Arm an idle reclaimer for an established tunnel: when no data flows in
// either direction for `client.tunnel_idle_timeout` ms, the tunnel is closed
// so orphaned tunnels (e.g. after a client process is killed without a FIN
// reaching us) do not pile up on the panel. p._touchIdle() resets the timer
// on traffic; the socket 'close' handler runs the normal cleanup/logging.
function armTunnelIdle(clientManager: ClientManager, p: PendingRecord, socket: NetSocket | undefined) {
  const ms = (clientManager.config?.client && clientManager.config.client.tunnel_idle_timeout) || 0;
  if (!(ms > 0)) {
    p._touchIdle = null;
    return;
  }
  p._touchIdle = () => {
    if (p._idleTimer) clearTimeout(p._idleTimer);
    p._idleTimer = setTimeout(() => {
      p._idleTimer = null;
      if (socket && !socket.destroyed) {
        try {
          socket.end();
        } catch (_) {
          // ignore
        }
      }
    }, ms);
  };
  p._touchIdle();
}

function handleTunnelReady(clientManager: ClientManager, stream: MuxStreamLike, _logger: AppLogger) {
  const headers = asRecord(stream.headers);
  const msgId = asString(headers.id) || String(stream.id);

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p) return;

  if (p.timeout) clearTimeout(p.timeout);
  p.timeout = null;

  const { socket, head, type, client } = p;

  if (socket) {
    if (type === 'socks5') {
      safeWrite(socket, encodeSocks5Reply(0x00));
    } else {
      safeWrite(socket, 'HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) safeWrite(socket, head as Buffer);
    }
  }

  clientManager.trackSuccess(client?.id);

  // Forward tunnel data through the stream
  socket?.on('data', (data: Buffer) => {
    if (p._touchIdle) p._touchIdle();
    if (stream.state !== 'closed' && stream.state !== 'half_closed_local') {
      stream.sendData(data);
      clientManager.trackBytes(client?.id, data.length, 0);
    }
  });

  socket?.on('close', () => {
    if (p._idleTimer) clearTimeout(p._idleTimer);
    recordTunnelLog(clientManager, p);
    stream.close();
    clientManager.pendingTunnels.delete(msgId);
    if (client) client.pendingTunnels.delete(msgId);
  });

  socket?.on('error', () => {});

  // Forward stream data back to the socket
  stream._onData = (chunk: Buffer) => {
    if (p._touchIdle) p._touchIdle();
    safeWrite(socket, chunk);
    clientManager.trackBytes(client?.id, 0, chunk.length);
  };
  stream._onEnd = () => {
    if (socket && !socket.destroyed) socket.end();
  };
  stream._onError = (_reason: string | number) => {
    if (socket && !socket.destroyed) {
      try {
        // Only reply with failure when the success reply never went out
        // (p.ready), otherwise a late error double-writes the socket.
        if (!p.ready) {
          if (p.type === 'socks5') safeWrite(socket, encodeSocks5Reply(0x01));
          else socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
        socket.end();
      } catch (_) {
        // ignore
      }
    }
    clientManager.pendingTunnels.delete(msgId);
    if (client) client.pendingTunnels.delete(msgId);
  };

  armTunnelIdle(clientManager, p, socket);
  p.ready = true;
}

function handleTunnelData(clientManager: ClientManager, stream: MuxStreamLike, _logger: AppLogger) {
  const headers = asRecord(stream.headers);
  const msgId = asString(headers.id) || String(stream.id);

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p || !p.socket || p.socket.destroyed) return;

  // Collect data from the stream
  stream._onData = (chunk: Buffer) => {
    if (p._touchIdle) p._touchIdle();
    safeWrite(p.socket, chunk);
    clientManager.trackBytes(p.client?.id, 0, chunk.length);
  };
}

function handleTunnelClose(clientManager: ClientManager, stream: MuxStreamLike, _logger: AppLogger) {
  const headers = asRecord(stream.headers);
  const msgId = asString(headers.id) || String(stream.id);

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p) return;
  if (p.socket && !p.socket.destroyed) p.socket.end();
  if (p.timeout) clearTimeout(p.timeout);
  clientManager.pendingTunnels.delete(msgId);
  if (p.client) p.client.pendingTunnels.delete(msgId);
}

function handleTunnelError(clientManager: ClientManager, stream: MuxStreamLike, _logger: AppLogger) {
  const headers = asRecord(stream.headers);
  const msgId = asString(headers.id) || String(stream.id);

  const p = clientManager.pendingTunnels.get(msgId);
  if (!p) return;
  if (p.timeout) clearTimeout(p.timeout);

  // tunnel_error is NOT a node health failure: the node is alive and answered
  // (it explicitly reported the connect failure / refused / timed out on the
  // target, or is at capacity). Feeding the circuit breaker here makes a
  // busy crawler that touches unreachable/refused targets open the breaker on
  // healthy nodes, rejecting every later tunnel with reply 0x01. Node health
  // is signaled by tunnel_timeout (the node never answered at all) instead.
  const established = !!p.ready;

  if (p.socket && !p.socket.destroyed) {
    try {
      // Only send the failure reply if the tunnel was never confirmed
      // (p.ready), so an error racing a success cannot double-write.
      if (!established) {
        if (p.type === 'socks5') safeWrite(p.socket, encodeSocks5Reply(0x01));
        else p.socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      p.socket.end();
    } catch (_) {
      // ignore
    }
  }

  clientManager.pendingTunnels.delete(msgId);
  if (p.client) p.client.pendingTunnels.delete(msgId);
}

// Handle a legacy JSON-shaped message delivered over a mux stream (payload in
// the stream body) by dispatching to the JSON handler for that type.
function handleLegacyStream(clientManager: ClientManager, stream: MuxStreamLike, _logger: AppLogger) {
  // Unknown stream type - just close it
  stream.close();
}

// =============================================================================
// Legacy JSON handlers (backward compatible with v1/v2 clients)
// =============================================================================

function handleClientResponseLegacy(clientManager: ClientManager, msg: ClientMessage, _logger: AppLogger) {
  const id = asString(msg.id);
  const p = clientManager.pendingRequests.get(id);
  if (!p) return;

  if (p.timeout) clearTimeout(p.timeout);
  clientManager.pendingRequests.delete(id);

  const { res, clientId, startTime } = p;
  const duration = startTime ? Date.now() - startTime : 0;

  // Cache response
  if (p._onResponse) {
    try {
      p._onResponse(asRecord(msg));
    } catch (_) {
      // ignore
    }
  }

  // Audit logging
  if (clientManager.audit && p._audit) {
    try {
      clientManager.audit.logRequest({
        ...p._audit,
        requestId: id,
        status: asNumber(msg.statusCode) >= 400 ? 'error' : 'success',
        statusCode: asNumber(msg.statusCode),
        duration,
        error: asString(msg.error),
      });
    } catch (_) {
      // ignore
    }
  }

  // Find client and remove from pending
  for (const c of clientManager.clients.values()) {
    if (c.pendingRequests.has(id)) {
      c.pendingRequests.delete(id);
      break;
    }
  }

  if (res && !res.headersSent) {
    const respHeaders = asRecord(msg.headers);
    delete respHeaders['transfer-encoding'];
    delete respHeaders['connection'];
    delete respHeaders['proxy-connection'];

    const statusCode = asNumber(msg.statusCode) || 200;
    const body = typeof msg.body === 'string' && msg.body.length > 0 ? Buffer.from(msg.body, 'base64') : null;
    res.writeHead(statusCode, asString(msg.statusMessage), respHeaders as OutgoingHttpHeaders);
    res.end(body);

    clientManager.trackRequest('http', statusCode, duration, clientId);
    // Count upstream failures as circuit breaker failures
    if (statusCode >= 500 || msg.error) {
      clientManager.trackError(clientId, 'upstream_' + statusCode);
    } else {
      clientManager.trackSuccess(clientId);
    }
    if (body) clientManager.trackBytes(clientId, 0, body.length);
  }
}

function handleTunnelReadyLegacy(clientManager: ClientManager, msg: ClientMessage, _logger: AppLogger) {
  const id = asString(msg.id);
  const p = clientManager.pendingTunnels.get(id);
  if (!p) return;

  if (p.timeout) clearTimeout(p.timeout);
  p.timeout = null;

  const { socket, head, type, client, startTime } = p;
  const duration = startTime ? Date.now() - startTime : 0;

  if (socket) {
    if (type === 'socks5') {
      safeWrite(socket, encodeSocks5Reply(0x00));
    } else {
      safeWrite(socket, 'HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) safeWrite(socket, head as Buffer);
    }
  }
  clientManager.trackSuccess(client?.id);
  void duration;

  socket?.on('data', (data: Buffer) => {
    if (p._touchIdle) p._touchIdle();
    if (client && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify({ type: 'tunnel_data', id, data: data.toString('base64') }));
      clientManager.trackBytes(client.id, data.length, 0);
    }
  });

  socket?.on('close', () => {
    if (p._idleTimer) clearTimeout(p._idleTimer);
    recordTunnelLog(clientManager, p);
    if (client && client.ws.readyState === 1) {
      try {
        client.ws.send(JSON.stringify({ type: 'tunnel_close', id }));
      } catch (_) {
        // ignore
      }
    }
    clientManager.pendingTunnels.delete(id);
    if (client) client.pendingTunnels.delete(id);
  });

  socket?.on('error', () => {});

  if (socket) armTunnelIdle(clientManager, p, socket);
  p.ready = true;
}

function handleTunnelDataLegacy(clientManager: ClientManager, msg: ClientMessage, _logger: AppLogger) {
  const id = asString(msg.id);
  const p = clientManager.pendingTunnels.get(id);
  if (!p || !p.socket || p.socket.destroyed) return;
  if (p._touchIdle) p._touchIdle();
  const data = Buffer.from(asString(msg.data), 'base64');
  safeWrite(p.socket, data);
  clientManager.trackBytes(p.client?.id, 0, data.length);
}

function handleTunnelCloseLegacy(clientManager: ClientManager, msg: ClientMessage, _logger: AppLogger) {
  const id = asString(msg.id);
  const p = clientManager.pendingTunnels.get(id);
  if (!p) return;
  if (p.socket && !p.socket.destroyed) p.socket.end();
  if (p.timeout) clearTimeout(p.timeout);
  clientManager.pendingTunnels.delete(id);
  if (p.client) p.client.pendingTunnels.delete(id);
}

function handleTunnelErrorLegacy(clientManager: ClientManager, msg: ClientMessage, _logger: AppLogger) {
  const id = asString(msg.id);
  const p = clientManager.pendingTunnels.get(id);
  if (!p) return;
  if (p.timeout) clearTimeout(p.timeout);

  // tunnel_error is not a node health failure — see handleTunnelError. The
  // node answered; only unresponsiveness (tunnel_timeout) feeds the breaker.
  const established = !!p.ready;

  if (p.socket && !p.socket.destroyed) {
    try {
      // Only send the failure reply if the tunnel was never confirmed
      // (p.ready), so an error racing a success cannot double-write.
      if (!established) {
        if (p.type === 'socks5') safeWrite(p.socket, encodeSocks5Reply(0x01));
        else p.socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      p.socket.end();
    } catch (_) {
      // ignore
    }
  }

  clientManager.pendingTunnels.delete(id);
  if (p.client) p.client.pendingTunnels.delete(id);
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
