#!/usr/bin/env node

// =============================================================================
// Node-Proxy Client v2.0
// Connects to the proxy server and forwards traffic (HTTP proxy + TCP tunnel)
// =============================================================================

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const url = require('url');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StreamMux } = require('./lib/stream-mux');

// =============================================================================
// Configuration
// =============================================================================
const DEFAULTS = {
  server_url: 'ws://127.0.0.1:3000/ws',
  auth_token: 'node-proxy-default-token',
  reconnect_delay: 3000,
  max_reconnect_delay: 30000,
  reconnect_jitter: 1000,
  heartbeat_interval: 15000,
  request_timeout: 30000,
  tunnel_timeout: 30000,
  max_concurrent_requests: 100,
  region: 'unknown',
  tags: '',
  tls_reject_unauthorized: false,
};

function loadConfig() {
  const config = { ...DEFAULTS };

  // Try to load config file
  const configPaths = [
    process.env.CONFIG_PATH,
    path.join(process.cwd(), 'config.yaml'),
    path.join(process.cwd(), 'config.yml'),
    path.join(__dirname, 'config.yaml'),
    path.join(__dirname, 'config.yml'),
  ];

  for (const cp of configPaths) {
    if (cp && fs.existsSync(cp)) {
      try {
        const yaml = require('js-yaml');
        const doc = yaml.load(fs.readFileSync(cp, 'utf8'));
        if (doc && doc.server_url) config.server_url = doc.server_url;
        if (doc && doc.auth_token) config.auth_token = doc.auth_token;
        if (doc && doc.reconnect_delay) config.reconnect_delay = doc.reconnect_delay;
        if (doc && doc.max_reconnect_delay) config.max_reconnect_delay = doc.max_reconnect_delay;
        if (doc && doc.heartbeat_interval) config.heartbeat_interval = doc.heartbeat_interval;
        if (doc && doc.request_timeout) config.request_timeout = doc.request_timeout;
        if (doc && doc.tunnel_timeout) config.tunnel_timeout = doc.tunnel_timeout;
        if (doc && doc.max_concurrent_requests) config.max_concurrent_requests = doc.max_concurrent_requests;
        if (doc && doc.region) config.region = doc.region;
        if (doc && doc.tags) config.tags = doc.tags;
        if (doc && doc.tls_reject_unauthorized !== undefined) config.tls_reject_unauthorized = doc.tls_reject_unauthorized;
      } catch (_) {}
      break;
    }
  }

  // Override with env vars
  const envMap = {
    SERVER_URL: 'server_url',
    AUTH_TOKEN: 'auth_token',
    RECONNECT_DELAY: 'reconnect_delay',
    MAX_RECONNECT_DELAY: 'max_reconnect_delay',
    HEARTBEAT_INTERVAL: 'heartbeat_interval',
    REQUEST_TIMEOUT: 'request_timeout',
    TUNNEL_TIMEOUT: 'tunnel_timeout',
    MAX_CONCURRENT_REQUESTS: 'max_concurrent_requests',
    REGION: 'region',
    NODE_REGION: 'region',
    TAGS: 'tags',
    TLS_REJECT_UNAUTHORIZED: 'tls_reject_unauthorized',
  };

  for (const [envKey, configKey] of Object.entries(envMap)) {
    if (process.env[envKey] !== undefined) {
      let val = process.env[envKey];
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^\d+$/.test(val)) val = parseInt(val, 10);
      config[configKey] = val;
    }
  }

  return config;
}

const CONFIG = loadConfig();

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
// State
// =============================================================================
const activeRequests = new Map();
const activeTunnels = new Map();
let ws = null;
let reconnectAttempt = 0;
let heartbeatTimer = null;
let currentClientId = null;
let intentionalClose = false;

// =============================================================================
// Logging
// =============================================================================
function log(level, message, data) {
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
    for (const iface of interfaces[name]) {
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
    region: CONFIG.region,
    tags: CONFIG.tags ? CONFIG.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
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
  if (ws) {
    try { ws.close(); } catch (_) {}
  }

  log('info', `Connecting to ${CONFIG.server_url} ...`);

  const wsOptions = {
    rejectUnauthorized: CONFIG.tls_reject_unauthorized,
    handshakeTimeout: 10000,
  };

  ws = new WebSocket(CONFIG.server_url, wsOptions);

  ws.on('open', () => {
    log('info', 'Connected to server');
    reconnectAttempt = 0;
    intentionalClose = false;
    ws.send(JSON.stringify({ type: 'auth', token: CONFIG.auth_token }));
  });

  // Create StreamMux for multiplexed streams (binary frames)
  ws.mux = new StreamMux(ws);

  // Handle multiplexed streams from the server (requests & tunnels)
  ws.mux.onStream((stream) => {
    handleMuxStream(stream);
  });

  ws.on('message', (raw, isBinary) => {
    // Binary frames are handled by StreamMux
    if (isBinary === true) {
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(msg);
    } catch (err) {
      log('error', 'Invalid message: ' + err.message);
    }
  });

  ws.on('close', (code, reason) => {
    log('info', `Disconnected (code: ${code}, reason: ${reason || 'none'})`);
    cleanupAll();
    if (!intentionalClose) {
      scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    log('error', 'WebSocket error: ' + err.message);
  });
}

function scheduleReconnect() {
  const delay = Math.min(
    CONFIG.reconnect_delay * Math.pow(1.5, reconnectAttempt) + Math.random() * CONFIG.reconnect_jitter,
    CONFIG.max_reconnect_delay
  );
  reconnectAttempt++;
  log('info', `Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
  setTimeout(connect, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  if (CONFIG.heartbeat_interval <= 0) return;
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }));
      // Also send stats
      ws.send(JSON.stringify({
        type: 'stats',
        stats: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          activeRequests: activeRequests.size,
          activeTunnels: activeTunnels.size,
        },
      }));
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
function handleMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      log('info', 'Authentication successful');
      ws.send(JSON.stringify({ type: 'info', info: getSystemInfo() }));
      startHeartbeat();
      break;

    case 'auth_error':
      log('error', 'Authentication failed: ' + (msg.message || 'Invalid token'));
      intentionalClose = true;
      ws.close();
      process.exit(1);
      break;

    case 'info_ok':
      currentClientId = msg.clientId;
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

    case 'error':
      log('warn', 'Server error: ' + (msg.message || ''));
      break;

    default:
      log('debug', 'Unknown message type: ' + msg.type);
  }
}

// =============================================================================
// StreamMux Stream Handler (binary protocol)
// =============================================================================
function handleMuxStream(stream) {
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

function handleMuxRequest(stream, headers) {
  const requestId = headers.id || stream.id;

  if (activeRequests.size >= CONFIG.max_concurrent_requests) {
    stream.sendHeaders({ type: 'response', id: requestId, statusCode: 503, statusMessage: 'Service Unavailable', headers: { 'content-type': 'text/plain' } });
    stream.sendData(Buffer.from('Client busy'), true);
    return;
  }

  // Collect body from DATA frames
  const bodyChunks = [];
  stream._onData = (chunk) => {
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

function executeMuxRequest(stream, headers, body) {
  const requestId = headers.id || stream.id;
  const { method, url: targetUrl, requestHeaders } = headers;

  try {
    const parsedUrl = new URL(targetUrl);
    const options = {
      method: method || 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: requestHeaders || headers.headers || {},
      rejectUnauthorized: CONFIG.tls_reject_unauthorized === false ? false : true,
      timeout: CONFIG.request_timeout,
    };

    delete options.headers['host'];
    delete options.headers['proxy-connection'];
    delete options.headers['transfer-encoding'];

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
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

    req.on('error', (err) => {
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
    stream.sendData(Buffer.from('Invalid request: ' + err.message), true);
  }
}

function handleMuxTunnel(stream, headers) {
  const tunnelId = headers.id || stream.id;
  const { host, port } = headers;

  if (activeTunnels.size >= CONFIG.max_concurrent_requests) {
    stream.sendHeaders({ type: 'tunnel_error', id: tunnelId, message: 'Client busy' });
    stream.close();
    return;
  }

  log('info', `Opening tunnel ${tunnelId} to ${host}:${port}`);

  const socket = new net.Socket();

  const timeout = setTimeout(() => {
    log('warn', `Tunnel ${tunnelId} timeout to ${host}:${port}`);
    socket.destroy();
    stream.sendHeaders({ type: 'tunnel_error', id: tunnelId, message: 'Connection timeout' });
    stream.close();
    activeTunnels.delete(tunnelId);
  }, CONFIG.tunnel_timeout);

  socket.connect(port, host, () => {
    clearTimeout(timeout);
    log('info', `Tunnel ${tunnelId} established to ${host}:${port}`);

    stream.sendHeaders({ type: 'tunnel_ready', id: tunnelId });

    socket.on('data', (data) => {
      if (stream.state !== 'closed' && stream.state !== 'half_closed_local') {
        stream.sendData(data);
      }
    });
  });

  socket.on('error', (err) => {
    clearTimeout(timeout);
    log('error', `Tunnel ${tunnelId} error: ${err.message}`);
    stream.sendHeaders({ type: 'tunnel_error', id: tunnelId, message: err.message });
    stream.close();
    activeTunnels.delete(tunnelId);
  });

  socket.on('close', () => {
    clearTimeout(timeout);
    log('debug', `Tunnel ${tunnelId} closed`);
    stream.close();
    activeTunnels.delete(tunnelId);
  });

  // Forward stream data to the socket
  stream._onData = (chunk) => {
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
// HTTP Request Handler
// =============================================================================
function handleRequest(msg) {
  const { id, method, url: targetUrl, headers, body } = msg;

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
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks); // raw Buffer
        sendResponse(id, res.statusCode, res.statusMessage || '', res.headers, responseBody);
        activeRequests.delete(id);
      });
    });

    req.on('error', (err) => {
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
    sendResponse(id, 400, 'Bad Request', { 'content-type': 'text/plain' }, 'Invalid request: ' + err.message);
  }
}

function sendResponse(id, statusCode, statusMessage, headers, body) {
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
  ws.send(JSON.stringify(msg), (err) => {
    if (err) log('error', `Failed to send response ${id}: ${err.message}`);
  });
}

// =============================================================================
// Tunnel Handler
// =============================================================================
function handleTunnelOpen(msg) {
  const { id, host, port } = msg;

  if (activeTunnels.size >= CONFIG.max_concurrent_requests) {
    ws.send(JSON.stringify({ type: 'tunnel_error', id, message: 'Client busy' }));
    return;
  }

  log('info', `Opening tunnel ${id} to ${host}:${port}`);

  const socket = new net.Socket();

  const timeout = setTimeout(() => {
    log('warn', `Tunnel ${id} timeout to ${host}:${port}`);
    socket.destroy();
    ws.send(JSON.stringify({ type: 'tunnel_error', id, message: 'Connection timeout' }));
    activeTunnels.delete(id);
  }, CONFIG.tunnel_timeout);

  socket.connect(port, host, () => {
    clearTimeout(timeout);
    log('info', `Tunnel ${id} established to ${host}:${port}`);

    ws.send(JSON.stringify({ type: 'tunnel_ready', id }));

    socket.on('data', (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'tunnel_data', id, data: data.toString('base64') }));
      }
    });
  });

  socket.on('error', (err) => {
    clearTimeout(timeout);
    log('error', `Tunnel ${id} error: ${err.message}`);
    ws.send(JSON.stringify({ type: 'tunnel_error', id, message: err.message }));
    activeTunnels.delete(id);
  });

  socket.on('close', () => {
    clearTimeout(timeout);
    log('debug', `Tunnel ${id} closed`);
    ws.send(JSON.stringify({ type: 'tunnel_close', id }));
    activeTunnels.delete(id);
  });

  activeTunnels.set(id, { socket, timeout });
}

function handleTunnelData(msg) {
  const tunnel = activeTunnels.get(msg.id);
  if (!tunnel || tunnel.socket.destroyed) return;
  const data = Buffer.from(msg.data, 'base64');
  tunnel.socket.write(data);
}

function handleTunnelClose(msg) {
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

// udpClients: assocId -> { socket: dgram.Socket, pending: Map<requestId, rinfo> }
const udpClients = new Map();

function handleUdpData(msg) {
  const { id, assocId, host, port, data, src } = msg;
  if (!assocId || !host || !port) return;
  if (!data) return;

  try {
    const payload = Buffer.from(data, 'base64');

    // Get or create the UDP socket for this association
    let udp = udpClients.get(assocId);
    if (!udp) {
      const socket = dgram.createSocket('udp4');
      udp = { socket, pending: new Map() };
      udpClients.set(assocId, udp);

      socket.on('message', (respBuf, rinfo) => {
        // Find the pending request that matches this response (by source port)
        let matchedId = null;
        for (const [reqId, reqInfo] of udp.pending) {
          if (reqInfo.rinfo && reqInfo.rinfo.port === rinfo.port) {
            matchedId = reqId;
            break;
          }
        }
        // If no exact match, send to the most recent request
        if (!matchedId && udp.pending.size > 0) {
          matchedId = [...udp.pending.keys()][udp.pending.size - 1];
        }
        const reqInfo = matchedId ? udp.pending.get(matchedId) : null;
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

      socket.on('error', (err) => {
        log('error', `UDP relay error: ${err.message}`);
        try { socket.close(); } catch (_) {}
        udpClients.delete(assocId);
      });

      // Close socket when association ends (server sends tunnel_close or timeout)
      const closeTimer = setTimeout(() => {
        try { socket.close(); } catch (_) {}
        udpClients.delete(assocId);
      }, 180000); // 3 min idle timeout
      udp.closeTimer = closeTimer;
      socket.on('close', () => clearTimeout(closeTimer));
    } else {
      // Reset idle timer
      clearTimeout(udp.closeTimer);
      udp.closeTimer = setTimeout(() => {
        try { udp.socket.close(); } catch (_) {}
        udpClients.delete(assocId);
      }, 180000);
    }

    // Remember request origin for response routing
    udp.pending.set(id, { rinfo: { port: 0, address: '' }, time: Date.now() });

    // Send datagram (host may be a domain name - dgram handles DNS)
    udp.socket.send(payload, port, host, (err) => {
      if (err) {
        log('error', `UDP send error to ${host}:${port}: ${err.message}`);
        udp.pending.delete(id);
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
    if (udp.pending.size > 200) {
      const oldest = [...udp.pending.keys()][0];
      udp.pending.delete(oldest);
    }
  } catch (err) {
    log('error', `UDP data error: ${err.message}`);
  }
}

// =============================================================================
// Cleanup
// =============================================================================
function cleanupAll() {
  stopHeartbeat();
  currentClientId = null;

  for (const [id, tunnel] of activeTunnels) {
    clearTimeout(tunnel.timeout);
    if (!tunnel.socket.destroyed) tunnel.socket.destroy();
  }
  activeTunnels.clear();

  for (const [id, req] of activeRequests) {
    if (req.req) req.req.destroy();
  }
  activeRequests.clear();

  for (const [assocId, udp] of udpClients) {
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
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception: ' + (err.stack || err.message));
});
process.on('unhandledRejection', (reason) => {
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
log('info', `  Region: ${CONFIG.region}`);
log('info', `  Concurrency: ${CONFIG.max_concurrent_requests}`);
log('info', '========================================');

connect();