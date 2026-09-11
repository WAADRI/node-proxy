#!/usr/bin/env node

// =============================================================================
// Node-Proxy Client v2.0
// Connects to the proxy server and forwards traffic (HTTP proxy + TCP tunnel)
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose: a
// value-level import would flip Node's module detection to ESM and break the
// entry-point semantics, so requires/module usage stays CommonJS and types are
// declared with import() queries / local interfaces only (stripped, no syntax).
// =============================================================================

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

// The type-only import below is erased by Node's type stripping (no ESM at
// runtime) but keeps this file a TypeScript module, so its top-level names do
// not collide with the global-script scope of sibling/legacy entry files.
import type { IncomingMessage } from 'http';

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { StreamMux } = require('./lib/stream-mux.ts');
const { ClientNetTest } = require('./lib/network-test.ts');
const netTestRunner = new ClientNetTest({ warn: (m: string) => log && log('warn', m), info: (m: string) => log && log('info', m), error: (m: string) => log && log('error', m) });
let netTestBusy = false;

// =============================================================================
// Configuration (schema-driven; see lib/config-schema.ts - issue #41)
// =============================================================================
const { loadClientConfig } = require('./lib/config-schema.ts');
const CONFIG = loadClientConfig({
  filePaths: [
    process.env.CONFIG_PATH,
    path.join(process.cwd(), 'config.yaml'),
    path.join(process.cwd(), 'config.yml'),
    path.join(__dirname, 'config.yaml'),
    path.join(__dirname, 'config.yml'),
  ],
});

// =============================================================================
// Persistent client ID (stable across reconnects so server metadata persists)
// Priority: CLIENT_ID env var > CLIENT_ID_FILE > auto-generated UUID
// =============================================================================
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_ID_FILE = process.env.CLIENT_ID_FILE || path.join(os.homedir(), '.node-proxy-client-id');
let persistentClientId = CLIENT_ID;
if (!persistentClientId) {
  try {
    if (fs.existsSync(CLIENT_ID_FILE)) {
      persistentClientId = fs.readFileSync(CLIENT_ID_FILE, 'utf8').trim();
    }
  } catch (_) {}
  if (!persistentClientId) {
    persistentClientId = require('crypto').randomUUID();
    try {
      fs.writeFileSync(CLIENT_ID_FILE, persistentClientId);
    } catch (_) {}
  }
}

// =============================================================================
// Out-of-process liveness beacon
// =============================================================================
// Written from its own interval, independent of the connection state, so the
// beacon means exactly one thing: "this process is still running its event
// loop". A blocked or stalled loop cannot keep it fresh, and an in-process
// watchdog cannot notice such a stall (it runs on the very loop that is stuck).
// That is how a node ends up silently offline: TCP still up, panel shows
// disconnected, no logs, no reconnect, manual restart required.
// client/healthcheck.sh (the container HEALTHCHECK) watches this file and
// restarts the container when the beacon goes stale, so such a stall self-heals.
const LIVENESS_FILE = process.env.LIVENESS_FILE || path.join(os.tmpdir(), 'node-proxy-liveness');
const LIVENESS_INTERVAL_MS = 10000;

function writeLivenessBeacon(): void {
  try {
    fs.writeFileSync(LIVENESS_FILE, String(Math.floor(Date.now() / 1000)));
  } catch (_) {
    // A failed beacon must never take the client down (e.g. read-only fs).
  }
}

function startLivenessBeacon(): void {
  writeLivenessBeacon();
  const timer = setInterval(writeLivenessBeacon, LIVENESS_INTERVAL_MS);
  // The beacon must never be the reason the process stays alive.
  if (typeof timer.unref === 'function') timer.unref();
}

// =============================================================================
// State
// =============================================================================
const activeRequests = new Map();
const activeTunnels = new Map();
let ws: WsClient | null = null;
let reconnectAttempt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentClientId: string | null = null;
let intentionalClose = false;
// When the socket last entered the CONNECTING state (0 = not connecting).
// Bounds a handshake that never completes so the watchdog can force a retry.
let connectingSince = 0;

// Liveness detection: the server never replies to the JSON heartbeat, so we
// additionally send ws protocol-level pings and expect pongs. A TCP connection
// that silently dies (server killed without FIN, NAT/firewall idle timeout)
// fires no close/error event - without this counter the node would hang
// forever instead of reconnecting.
let missedPongs = 0;
const MAX_MISSED_PONGS = 3; // ~3 x heartbeat_interval before declaring death

// A ws close handshake can stall forever when the peer vanished without a FIN:
// the socket parks in CLOSING, the 'close' event never fires, and the node sits
// there disconnected until it is restarted by hand. After this long in
// CONNECTING (or any time found in CLOSING/CLOSED) the watchdog tears the
// socket down itself and reconnects.
const CONNECT_GRACE_MS = 20000;

// --- Duck types for the ws instance (client has no @types/ws) ----------------
interface WsClient {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  send(data: Buffer, options: { binary: boolean }, cb?: (err?: Error) => void): void;
  ping(): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | string, isBinary: boolean) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  mux?: MuxLike;
}

// StreamMux stream/mux structural types (stream-mux.ts stays CJS/script-style
// with no import statements, so it cannot be type-queried; cover only members
// this entry touches, mirroring the pre-migration JS usage).
interface MuxStreamHeaders {
  type?: string;
  id?: string | number;
  method?: string;
  url?: string;
  host?: string;
  port?: number;
  requestHeaders?: Record<string, string>;
  headers?: Record<string, string>;
}

interface MuxStreamLike {
  id: number | string;
  state?: string;
  headers?: MuxStreamHeaders | null;
  sendHeaders(headers: Record<string, unknown>, endStream?: boolean): void;
  sendData(data: Buffer | string, endStream?: boolean): void;
  close(): void;
  _onData?: ((data: Buffer) => void) | null;
  _onEnd?: (() => void) | null;
  _onError?: ((reason: string | number) => void) | null;
}

interface MuxLike {
  onStream(cb: (stream: MuxStreamLike) => void): void;
}

// Message shapes pushed by the server (see server protocol docs)
type ServerMsg =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; message?: string }
  | { type: 'info_ok'; clientId?: string }
  | { type: 'request'; id: string; method?: string; url: string; headers?: Record<string, string>; body?: string }
  | { type: 'tunnel_open'; id: string; host: string; port: number }
  | { type: 'tunnel_data'; id: string; data: string }
  | { type: 'tunnel_close'; id: string }
  | { type: 'udp_data'; id: string; assocId: string; host: string; port: number; data: string; src?: string }
  | { type: 'broadcast'; message?: string }
  | { type: 'net_test'; taskId: string; payload: { type: string; targets: string[]; options?: Record<string, unknown> } }
  | { type: 'error'; message?: string };

// =============================================================================
// Logging
// =============================================================================
function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// =============================================================================
// System Info
// =============================================================================
function getSystemInfo() {
  const interfaces = os.networkInterfaces();
  let localIp = 'unknown';
  for (const name of Object.keys(interfaces)) {
    const ifaces = interfaces[name];
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIp = iface.address;
        break;
      }
    }
    if (localIp !== 'unknown') break;
  }

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    localIp,
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    // Region / tags from config.yaml are reported as node-side defaults: the
    // panel stays authoritative (a value set there wins), but a node declaring
    // its identity in config.yaml must keep showing up after upgrading past
    // #89, which dropped this reporting and made existing configs look ignored.
    region: CONFIG.region ? String(CONFIG.region) : undefined,
    tags: CONFIG.tags
      ? String(CONFIG.tags).split(',').map((t: string) => t.trim()).filter(Boolean)
      : [],
    nodeVersion: process.version,
    pid: process.pid,
    uptime: os.uptime(),
    version: '3.0.0',
    // Stable client ID so the server can persist per-client metadata (weight/tags/limits)
    clientId: persistentClientId,
    // Protocol capability: client supports StreamMux (WebSocket multiplexing)
    supportsMux: true,
  };
}

// =============================================================================
// WebSocket Connection
// =============================================================================
function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch (_) {}
  }

  log('info', `Connecting to ${CONFIG.server_url} ...`);
  connectingSince = Date.now();

  const wsOptions = {
    rejectUnauthorized: CONFIG.tls_reject_unauthorized,
    handshakeTimeout: 10000,
  };

  let sock: WsClient;
  try {
    sock = new WebSocket(CONFIG.server_url, wsOptions);
  } catch (err) {
    // A constructor throw (bad URL, TLS setup failure) would otherwise escape
    // the reconnect timer and permanently kill the reconnect chain.
    log('error', 'Failed to create WebSocket: ' + (err instanceof Error ? err.message : String(err)));
    connectingSince = 0;
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.on('open', () => {
    log('info', 'Connected to server');
    reconnectAttempt = 0;
    intentionalClose = false;
    missedPongs = 0;
    connectingSince = 0;
    sock.send(JSON.stringify({ type: 'auth', token: CONFIG.auth_token }));
  });

  // ws protocol pong (server auto-replies to ping frames) -> connection alive
  sock.on('pong', () => {
    missedPongs = 0;
  });

  // Create StreamMux for multiplexed streams (binary frames)
  const mux: MuxLike = new StreamMux(sock);
  sock.mux = mux;

  // Handle multiplexed streams from the server (requests & tunnels)
  mux.onStream((stream: MuxStreamLike) => {
    handleMuxStream(stream);
  });

  sock.on('message', (raw: unknown, isBinary: boolean) => {
    // Binary frames are handled by StreamMux internally.
    // NOTE: ws 8.x delivers text frames as Buffer with isBinary=false, so we
    // must check the isBinary flag, NOT Buffer.isBuffer(), to distinguish them.
    if (Buffer.isBuffer(raw) && isBinary) {
      return;
    }

    try {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      handleMessage(msg);
    } catch (err) {
      log('error', 'Invalid message: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  sock.on('close', (code: unknown, reason: unknown) => {
    log('info', `Disconnected (code: ${code}, reason: ${reason || 'none'})`);
    connectingSince = 0;
    if (ws === sock) ws = null;
    // cleanupAll must never be allowed to swallow the reconnect: a throw here
    // used to abort the handler before scheduleReconnect() ran, leaving the
    // node permanently offline.
    try {
      cleanupAll();
    } catch (err) {
      log('error', 'cleanupAll failed on close: ' + (err instanceof Error ? err.message : String(err)));
    }
    if (!intentionalClose) {
      scheduleReconnect();
    }
  });

  sock.on('error', (err: unknown) => {
    log('error', 'WebSocket error: ' + (err instanceof Error ? err.message : String(err)));
    // Normally 'close' follows 'error' and drives the reconnect, but not for
    // every failure mode - make sure a reconnect is pending either way.
    if (!intentionalClose && ws === sock) {
      scheduleReconnect();
    }
  });
}

// Tear down a socket that can no longer recover and make sure a reconnect is
// scheduled. Needed because a stalled close handshake parks the socket in
// CLOSING, where neither 'close' nor 'error' ever fires again.
function forceReconnect(reason: string) {
  log('warn', `Forcing reconnect: ${reason}`);
  missedPongs = 0;
  connectingSince = 0;
  const sock = ws;
  ws = null;
  if (sock) {
    try {
      sock.terminate();
    } catch (_) {
      // ignore - terminate on an already-dead socket is harmless
    }
  }
  try {
    cleanupAll();
  } catch (err) {
    log('error', 'cleanupAll failed during forced reconnect: ' + (err instanceof Error ? err.message : String(err)));
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (intentionalClose) return;
  // Only ever one reconnect chain: 'close', 'error' and the watchdog can all
  // observe the same failure, and stacking timers would open several sockets.
  if (reconnectTimer) return;
  const delay = Math.min(
    CONFIG.reconnect_delay * Math.pow(1.5, reconnectAttempt) + Math.random() * CONFIG.reconnect_jitter,
    CONFIG.max_reconnect_delay
  );
  reconnectAttempt++;
  log('info', `Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  if (CONFIG.heartbeat_interval <= 0) return;
  heartbeatTimer = setInterval(() => {
    const sock = ws;
    if (!sock) {
      // No socket at all (e.g. a reconnect was lost): make sure one is coming.
      scheduleReconnect();
      return;
    }

    const state = sock.readyState;

    // CLOSING / CLOSED: a stalled close handshake never emits 'close' (the
    // peer vanished without a FIN), so waiting on the event leaves the node
    // silently offline forever. Drive the reconnect ourselves.
    if (state === WebSocket.CLOSING || state === WebSocket.CLOSED) {
      forceReconnect(`socket stuck in readyState ${state}`);
      return;
    }

    // CONNECTING: a handshake that never completes must not hang forever.
    if (state === WebSocket.CONNECTING) {
      if (connectingSince && Date.now() - connectingSince > CONNECT_GRACE_MS) {
        forceReconnect('handshake never completed');
      }
      return;
    }

    if (state !== WebSocket.OPEN) return;

    // Protocol-level ping: server (ws library) auto-replies with a pong.
    // If the pong stops arriving the TCP connection is half-dead even
    // though no close/error fired - force a reconnect in that case.
    try {
      sock.ping();
    } catch (err) {
      forceReconnect('ping failed: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }
    missedPongs++;
    if (missedPongs >= MAX_MISSED_PONGS) {
      forceReconnect(`no pong from server for ${missedPongs} heartbeats`);
      return;
    }
    try {
      // Server-side liveness (JSON heartbeat keeps server health-check happy)
      sock.send(JSON.stringify({ type: 'heartbeat' }));
      // Also send stats
      sock.send(JSON.stringify({
        type: 'stats',
        stats: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          activeRequests: activeRequests.size,
          activeTunnels: activeTunnels.size,
        },
      }));
    } catch (err) {
      forceReconnect('heartbeat send failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, CONFIG.heartbeat_interval);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// =============================================================================
// Message Handler
// =============================================================================
function handleMessage(msg: ServerMsg) {
  switch (msg.type) {
    case 'auth_ok': {
      log('info', 'Authentication successful');
      if (ws) ws.send(JSON.stringify({ type: 'info', info: getSystemInfo() }));
      startHeartbeat();
      break;
    }

    case 'auth_error':
      log('error', 'Authentication failed: ' + (msg.message || 'Invalid token'));
      intentionalClose = true;
      if (ws) ws.close();
      process.exit(1);
      break;

    case 'info_ok':
      currentClientId = msg.clientId || null;
      log('info', `Registered with ID: ${currentClientId}`);
      break;

    case 'request':
      handleRequest(msg);
      break;

    case 'tunnel_open':
      handleTunnelOpen(msg);
      break;

    case 'tunnel_data':
      handleTunnelData(msg);
      break;

    case 'tunnel_close':
      handleTunnelClose(msg);
      break;

    case 'udp_data':
      handleUdpData(msg);
      break;

    case 'broadcast':
      log('info', `[Broadcast] ${msg.message}`);
      break;

    case 'net_test':
      handleNetTest(msg);
      break;

    case 'error':
      log('warn', 'Server error: ' + (msg.message || ''));
      break;

    default:
      log('debug', 'Unknown message type');
  }
}

// =============================================================================
// Network test task (issue #31): server asks THIS node to run tests locally
// =============================================================================
function safeSend(obj: Record<string, unknown>) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function handleNetTest(msg: Extract<ServerMsg, { type: 'net_test' }>) {
  const taskId = msg.taskId;
  const payload = msg.payload;
  const targets = payload && Array.isArray(payload.targets) ? payload.targets.filter(Boolean) : [];
  if (!taskId || !payload || !targets.length) {
    return safeSend({ type: 'net_test_done', taskId, error: 'invalid task payload' });
  }
  if (netTestBusy) {
    return safeSend({ type: 'net_test_done', taskId, error: '节点忙：已有测试任务在执行' });
  }
  netTestBusy = true;
  log('info', `Net test started: ${payload.type} x ${targets.length} targets (${taskId})`);
  Promise.resolve()
    .then(() =>
      netTestRunner.run(payload.type, targets, payload.options || {}, (r: unknown) => {
        safeSend(Object.assign({ type: 'net_test_progress', taskId }, r as Record<string, unknown>));
      })
    )
    .then(() => {
      log('info', `Net test done: ${taskId}`);
      safeSend({ type: 'net_test_done', taskId });
    })
    .catch((err: Error) => {
      log('error', `Net test failed: ${err.message}`);
      safeSend({ type: 'net_test_done', taskId, error: err.message || String(err) });
    })
    .finally(() => {
      netTestBusy = false;
    });
}

// =============================================================================
// StreamMux Stream Handler (binary protocol)
// =============================================================================
function handleMuxStream(stream: MuxStreamLike) {
  const headers = stream.headers || {};

  // HTTP request stream
  if (headers.type === 'request' || headers.method) {
    handleMuxRequest(stream, headers);
    return;
  }

  // Tunnel stream (TUNNEL_OPEN)
  if (headers.type === 'tunnel_open' || (headers.host && headers.port)) {
    handleMuxTunnel(stream, headers);
    return;
  }

  // Unknown stream type - just close it
  stream.close();
}

function handleMuxRequest(stream: MuxStreamLike, headers: MuxStreamHeaders) {
  const requestId = headers.id || stream.id;

  if (activeRequests.size >= CONFIG.max_concurrent_requests) {
    stream.sendHeaders({ type: 'response', id: requestId, statusCode: 503, statusMessage: 'Service Unavailable', headers: { 'content-type': 'text/plain' } });
    stream.sendData(Buffer.from('Client busy'), true);
    return;
  }

  // Collect body from DATA frames
  const bodyChunks: Buffer[] = [];
  stream._onData = (chunk: Buffer) => {
    bodyChunks.push(chunk);
  };

  stream._onEnd = () => {
    const body = Buffer.concat(bodyChunks).toString('base64');
    executeMuxRequest(stream, headers, body);
  };

  // If the request had no body (END_STREAM on headers), handle it now
  if (stream.state === 'half_closed_remote' || stream.state === 'closed') {
    executeMuxRequest(stream, headers, '');
  }
}

function executeMuxRequest(stream: MuxStreamLike, headers: MuxStreamHeaders, body: string) {
  const requestId = headers.id || stream.id;
  const method = headers.method || 'GET';
  const targetUrl = headers.url || '';
  const requestHeaders = headers.requestHeaders || headers.headers || {};

  try {
    const parsedUrl = new URL(targetUrl);
    const options = {
      method,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: requestHeaders,
      rejectUnauthorized: CONFIG.tls_reject_unauthorized === false ? false : true,
      timeout: CONFIG.request_timeout,
    };

    delete options.headers['host'];
    delete options.headers['proxy-connection'];
    delete options.headers['transfer-encoding'];

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        stream.sendHeaders({
          type: 'response',
          id: requestId,
          statusCode: res.statusCode,
          statusMessage: res.statusMessage || '',
          headers: res.headers,
        });
        stream.sendData(responseBody, true);
        activeRequests.delete(requestId);
      });
    });

    req.on('error', (err: Error) => {
      // May fire after 'timeout' already destroyed the request and sent 504.
      if (!activeRequests.has(requestId)) return;
      log('error', `Request ${requestId} failed: ${err.message}`);
      stream.sendHeaders({ type: 'response', id: requestId, statusCode: 502, statusMessage: 'Bad Gateway', headers: { 'content-type': 'text/plain' } });
      stream.sendData(Buffer.from(err.message), true);
      activeRequests.delete(requestId);
    });

    req.on('timeout', () => {
      log('warn', `Request ${requestId} timed out after ${CONFIG.request_timeout}ms`);
      // Mark first so the 'error' event from destroy() does not double-send.
      if (!activeRequests.has(requestId)) return;
      activeRequests.delete(requestId);
      req.destroy();
      stream.sendHeaders({ type: 'response', id: requestId, statusCode: 504, statusMessage: 'Gateway Timeout', headers: { 'content-type': 'text/plain' } });
      stream.sendData(Buffer.from('Request timeout'), true);
    });

    if (body) req.write(Buffer.from(body, 'base64'));
    req.end();

    activeRequests.set(requestId, { req });
  } catch (err) {
    stream.sendHeaders({ type: 'response', id: requestId, statusCode: 400, statusMessage: 'Bad Request', headers: { 'content-type': 'text/plain' } });
    stream.sendData(Buffer.from('Invalid request: ' + (err instanceof Error ? err.message : String(err))), true);
  }
}

function handleMuxTunnel(stream: MuxStreamLike, headers: MuxStreamHeaders) {
  const tunnelId = headers.id || stream.id;
  const host = headers.host || '';
  const port = headers.port || 0;

  if (activeTunnels.size >= CONFIG.max_concurrent_requests) {
    stream.sendHeaders({ type: 'tunnel_error', id: tunnelId, message: 'Client busy' });
    stream.close();
    return;
  }

  log('info', `Opening tunnel ${tunnelId} to ${host}:${port}`);

  const socket = new net.Socket();

  // Distinguish connect-phase failures from errors on an established tunnel:
  // only the former should be reported as tunnel_error — a mid-stream reset
  // (e.g. ECONNRESET from the target) is normal teardown and the tunnel has
  // already reported tunnel_ready, so the server would only treat it as noise.
  let established = false;
  let reported = false;
  const failTunnel = (message: string, code?: string) => {
    if (reported) return;
    reported = true;
    stream.sendHeaders({ type: 'tunnel_error', id: tunnelId, message, code: code || '' });
    stream.close();
    activeTunnels.delete(tunnelId);
  };

  const timeout = setTimeout(() => {
    log('warn', `Tunnel ${tunnelId} timeout to ${host}:${port}`);
    socket.destroy();
    failTunnel('Connection timeout', 'ETIMEDOUT');
  }, CONFIG.tunnel_timeout);

  socket.connect(port, host, () => {
    clearTimeout(timeout);
    established = true;
    log('info', `Tunnel ${tunnelId} established to ${host}:${port}`);

    stream.sendHeaders({ type: 'tunnel_ready', id: tunnelId });

    socket.on('data', (data: Buffer) => {
      if (stream.state !== 'closed' && stream.state !== 'half_closed_local') {
        stream.sendData(data);
      }
    });
  });

  socket.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(timeout);
    if (!established) {
      // Connect-phase failure: report so the server can reply to the
      // SOCKS5/HTTP client promptly instead of waiting for its timeout.
      log('error', `Tunnel ${tunnelId} failed to ${host}:${port}: ${err.message}`);
      failTunnel(err.message, err.code || '');
      return;
    }
    // Established tunnel errored mid-stream (target reset, idle close, ...):
    // normal teardown. Tear the socket down; the 'close' handler reports
    // tunnel_close / END_STREAM. Do NOT send tunnel_error here.
    log('debug', `Tunnel ${tunnelId} error after established: ${err.message}`);
    if (!socket.destroyed) socket.destroy();
  });

  socket.on('close', () => {
    clearTimeout(timeout);
    log('debug', `Tunnel ${tunnelId} closed`);
    stream.close();
    activeTunnels.delete(tunnelId);
  });

  // Forward stream data to the socket
  stream._onData = (chunk: Buffer) => {
    if (!socket.destroyed) socket.write(chunk);
  };
  stream._onEnd = () => {
    if (!socket.destroyed) socket.end();
  };
  stream._onError = () => {
    if (!socket.destroyed) socket.destroy();
  };

  activeTunnels.set(tunnelId, { socket, timeout });
}

// =============================================================================
// HTTP Request Handler (JSON protocol)
// =============================================================================
function handleRequest(msg: Extract<ServerMsg, { type: 'request' }>) {
  const id = msg.id;
  const method = msg.method;
  const targetUrl = msg.url;
  const headers = msg.headers || {};
  const body = msg.body;

  if (activeRequests.size >= CONFIG.max_concurrent_requests) {
    sendResponse(id, 503, 'Service Unavailable', { 'content-type': 'text/plain' }, 'Client busy');
    return;
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const options = {
      method: method || 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: headers || {},
      rejectUnauthorized: CONFIG.tls_reject_unauthorized === false ? false : true,
      timeout: CONFIG.request_timeout,
    };

    delete options.headers['host'];
    delete options.headers['proxy-connection'];
    delete options.headers['transfer-encoding'];

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks); // raw Buffer
        sendResponse(id, res.statusCode, res.statusMessage || '', res.headers, responseBody);
        activeRequests.delete(id);
      });
    });

    req.on('error', (err: Error) => {
      // May fire after 'timeout' already destroyed the request and sent 504.
      if (!activeRequests.has(id)) return;
      log('error', `Request ${id} failed: ${err.message}`);
      sendResponse(id, 502, 'Bad Gateway', { 'content-type': 'text/plain' }, err.message);
      activeRequests.delete(id);
    });

    req.on('timeout', () => {
      if (!activeRequests.has(id)) return;
      activeRequests.delete(id);
      req.destroy();
      sendResponse(id, 504, 'Gateway Timeout', { 'content-type': 'text/plain' }, 'Request timeout');
    });

    if (body) req.write(Buffer.from(body, 'base64'));
    req.end();

    activeRequests.set(id, { req });
  } catch (err) {
    sendResponse(id, 400, 'Bad Request', { 'content-type': 'text/plain' }, 'Invalid request: ' + (err instanceof Error ? err.message : String(err)));
  }
}

function sendResponse(id: string, statusCode: number | undefined, statusMessage: string, headers: Record<string, unknown>, body: string | Buffer | null | undefined) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = {
    type: 'response',
    id,
    statusCode,
    statusMessage,
    headers: headers || {},
    // body: encode raw Buffer/string to base64 exactly once
    body: body == null ? '' : (Buffer.isBuffer(body) ? body.toString('base64') : Buffer.from(String(body)).toString('base64')),
  };
  ws.send(JSON.stringify(msg), (err?: Error) => {
    if (err) log('error', `Failed to send response ${id}: ${err.message}`);
  });
}

// =============================================================================
// Tunnel Handler (JSON protocol)
// =============================================================================
function handleTunnelOpen(msg: Extract<ServerMsg, { type: 'tunnel_open' }>) {
  const id = msg.id;
  const host = msg.host;
  const port = msg.port;

  if (activeTunnels.size >= CONFIG.max_concurrent_requests) {
    if (ws) ws.send(JSON.stringify({ type: 'tunnel_error', id, message: 'Client busy' }));
    return;
  }

  log('info', `Opening tunnel ${id} to ${host}:${port}`);

  const socket = new net.Socket();

  // Same semantics as the mux path: only connect-phase failures raise
  // tunnel_error; an error on an established tunnel is normal teardown.
  let established = false;
  const failTunnel = (message: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tunnel_error', id, message }));
    }
    if (!socket.destroyed) socket.destroy();
    activeTunnels.delete(id);
  };

  const timeout = setTimeout(() => {
    log('warn', `Tunnel ${id} timeout to ${host}:${port}`);
    failTunnel('Connection timeout');
  }, CONFIG.tunnel_timeout);

  socket.connect(port, host, () => {
    clearTimeout(timeout);
    established = true;
    log('info', `Tunnel ${id} established to ${host}:${port}`);

    if (ws) ws.send(JSON.stringify({ type: 'tunnel_ready', id }));

    socket.on('data', (data: Buffer) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'tunnel_data', id, data: data.toString('base64') }));
      }
    });
  });

  socket.on('error', (err: Error) => {
    clearTimeout(timeout);
    if (!established) {
      log('error', `Tunnel ${id} failed to ${host}:${port}: ${err.message}`);
      failTunnel(err.message);
      return;
    }
    log('debug', `Tunnel ${id} error after established: ${err.message}`);
    if (!socket.destroyed) socket.destroy();
  });

  socket.on('close', () => {
    clearTimeout(timeout);
    log('debug', `Tunnel ${id} closed`);
    if (ws) ws.send(JSON.stringify({ type: 'tunnel_close', id }));
    activeTunnels.delete(id);
  });

  activeTunnels.set(id, { socket, timeout });
}

function handleTunnelData(msg: Extract<ServerMsg, { type: 'tunnel_data' }>) {
  const tunnel = activeTunnels.get(msg.id);
  if (!tunnel || tunnel.socket.destroyed) return;
  const data = Buffer.from(msg.data, 'base64');
  tunnel.socket.write(data);
}

function handleTunnelClose(msg: Extract<ServerMsg, { type: 'tunnel_close' }>) {
  const tunnel = activeTunnels.get(msg.id);
  if (tunnel) {
    clearTimeout(tunnel.timeout);
    if (!tunnel.socket.destroyed) tunnel.socket.end();
    activeTunnels.delete(msg.id);
  }
}

// =============================================================================
// UDP Relay (SOCKS5 UDP ASSOCIATE support)
// Server forwards a UDP datagram as { type: 'udp_data', id, assocId, host, port, data(base64) }.
// Client sends the datagram to host:port and relays the response back.
// =============================================================================

interface UdpAssoc {
  socket: import('dgram').Socket;
  pending: Map<string, { rinfo: { port: number; address: string }; time: number }>;
  closeTimer: ReturnType<typeof setTimeout>;
}

// udpClients: assocId -> UdpAssoc
const udpClients = new Map<string, UdpAssoc>();

function handleUdpData(msg: Extract<ServerMsg, { type: 'udp_data' }>) {
  const id = msg.id;
  const assocId = msg.assocId;
  const host = msg.host;
  const port = msg.port;
  const data = msg.data;
  const src = msg.src;
  if (!assocId || !host || !port) return;
  if (!data) return;

  try {
    const payload = Buffer.from(data, 'base64');

    // Get or create the UDP socket for this association
    let udp = udpClients.get(assocId);
    if (!udp) {
      const socket: UdpAssoc['socket'] = dgram.createSocket('udp4');
      const pending: UdpAssoc['pending'] = new Map();
      udp = { socket, pending, closeTimer: setTimeout(() => {}, 0) };
      udpClients.set(assocId, udp);
      const assoc = udp; // fixed non-null reference for the callbacks below

      socket.on('message', (respBuf: Buffer, rinfo: { address: string; port: number }) => {
        // Find the pending request that matches this response (by source port)
        let matchedId: string | null = null;
        for (const [reqId, reqInfo] of assoc.pending) {
          if (reqInfo.rinfo && reqInfo.rinfo.port === rinfo.port) {
            matchedId = reqId;
            break;
          }
        }
        // If no exact match, send to the most recent request
        if (!matchedId && assoc.pending.size > 0) {
          const keys = [...assoc.pending.keys()];
          matchedId = keys[keys.length - 1] ?? null;
        }
        const reqInfo = matchedId ? assoc.pending.get(matchedId) : null;
        if (!reqInfo) return;

        // Relay response back to server (with original source address for routing)
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'udp_data_response',
            id: matchedId,
            assocId,
            src,
            rinfo: { address: rinfo.address, port: rinfo.port },
            data: respBuf.toString('base64'),
          }));
        }
      });

      socket.on('error', (err: Error) => {
        log('error', `UDP relay error: ${err.message}`);
        try { socket.close(); } catch (_) {}
        udpClients.delete(assocId);
      });

      // Close socket when association ends (server sends tunnel_close or timeout)
      const closeTimer = setTimeout(() => {
        try { socket.close(); } catch (_) {}
        udpClients.delete(assocId);
      }, 180000); // 3 min idle timeout
      assoc.closeTimer = closeTimer;
      socket.on('close', () => clearTimeout(closeTimer));
    } else {
      const existing = udp;
      // Reset idle timer
      clearTimeout(existing.closeTimer);
      existing.closeTimer = setTimeout(() => {
        try { existing.socket.close(); } catch (_) {}
        udpClients.delete(assocId);
      }, 180000);
    }

    const assoc = udp;
    // Remember request origin for response routing
    assoc.pending.set(id, { rinfo: { port: 0, address: '' }, time: Date.now() });

    // Send datagram (host may be a domain name - dgram handles DNS)
    assoc.socket.send(payload, port, host, (err: Error | null) => {
      if (err) {
        log('error', `UDP send error to ${host}:${port}: ${err.message}`);
        assoc.pending.delete(id);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'udp_data_response',
            id,
            assocId,
            src,
            error: err.message,
            data: '',
          }));
        }
      }
    });

    // Limit pending entries
    if (assoc.pending.size > 200) {
      const oldest = [...assoc.pending.keys()][0];
      if (oldest !== undefined) assoc.pending.delete(oldest);
    }
  } catch (err) {
    log('error', `UDP data error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// =============================================================================
// Cleanup
// =============================================================================
function cleanupAll() {
  stopHeartbeat();
  currentClientId = null;

  for (const [, tunnel] of activeTunnels) {
    clearTimeout(tunnel.timeout);
    if (!tunnel.socket.destroyed) tunnel.socket.destroy();
  }
  activeTunnels.clear();

  for (const [, req] of activeRequests) {
    if (req.req) req.req.destroy();
  }
  activeRequests.clear();

  for (const [, udp] of udpClients) {
    clearTimeout(udp.closeTimer);
    try { udp.socket.close(); } catch (_) {}
  }
  udpClients.clear();
}

// =============================================================================
// Graceful Shutdown
// =============================================================================
function shutdown() {
  log('info', 'Shutting down...');
  intentionalClose = true;
  cleanupAll();
  if (ws) {
    ws.close(1000, 'Client shutting down');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err: Error) => {
  log('error', 'Uncaught exception: ' + (err.stack || err.message));
  // Node's own guidance is that the process is in an undefined state here, so
  // never leave the reconnect chain broken: if the socket is not usable, force
  // a fresh connection instead of hanging silently (which is how a node ends
  // up shown as disconnected on the panel with no process restart).
  try {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      forceReconnect('uncaught exception with unhealthy socket');
    }
  } catch (_) {
    // last resort: must not throw out of the handler
  }
});
process.on('unhandledRejection', (reason: unknown) => {
  log('error', 'Unhandled rejection: ' + reason);
});

// =============================================================================
// Start
// =============================================================================
log('info', '========================================');
log('info', '  Node-Proxy Client v3.0');
log('info', '========================================');
log('info', `  Server: ${CONFIG.server_url}`);
log('info', `  Hostname: ${os.hostname()}`);
log('info', `  Platform: ${os.platform()} ${os.arch()}`);
log('info', `  Concurrency: ${CONFIG.max_concurrent_requests}`);
// Surface the optional node-side identity so a config that the server will not
// display (region/tags) is visible in the startup log.
log('info', `  Region: ${CONFIG.region ? String(CONFIG.region) : '(not set)'}`);
log('info', `  Tags: ${CONFIG.tags ? String(CONFIG.tags) : '(not set)'}`);
log('info', '========================================');

// Start the liveness beacon before connecting: the container health check uses
// it to detect a stalled event loop, which no in-process watchdog can see.
startLivenessBeacon();

connect();
