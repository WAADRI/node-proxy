// =============================================================================
// SOCKS5 Proxy v3.0 - Full SOCKS5 with UDP ASSOCIATE + IPv6
// =============================================================================
'use strict';

const net = require('net');
const dgram = require('dgram');
const { v4: uuidv4 } = require('uuid');

function createSocks5Proxy(clientManager, authManager, config, logger, pluginManager) {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let state = 'greeting';
    let bufs = [];
    let bufLen = 0;
    let tunnelId = null;
    let currentClient = null;
    let currentTimeout = null;
    let socksUsername = '';
    let startTime = 0;
    let udpSocket = null; // For UDP ASSOCIATE
    let udpAssocId = null;

    function cleanup() {
      if (currentTimeout) clearTimeout(currentTimeout);
      if (tunnelId && currentClient) {
        currentClient.pendingTunnels.delete(tunnelId);
        clientManager.pendingTunnels.delete(tunnelId);
        try {
          currentClient.ws.send(JSON.stringify({ type: 'tunnel_close', id: tunnelId }));
        } catch (_) {}
      }
      if (udpSocket) {
        try { udpSocket.close(); } catch (_) {}
        udpSocket = null;
      }
    }

    socket.on('data', (data) => {
      bufs.push(data);
      bufLen += data.length;
      const buf = Buffer.concat(bufs, bufLen);

      try {
        // ---- STATE: GREETING ----
        if (state === 'greeting' && bufLen >= 2) {
          const ver = buf[0];
          const nmethods = buf[1];
          if (bufLen < 2 + nmethods) return;
          if (ver !== 0x05) { socket.end(); return; }

          const proxyAuth = authManager.config.auth.proxy;
          let methods = [];
          for (let i = 0; i < nmethods; i++) methods.push(buf[2 + i]);

          if (proxyAuth.enabled) {
            if (methods.includes(0x02)) {
              socket.write(Buffer.from([0x05, 0x02]));
              state = 'auth_sub';
              bufs = []; bufLen = 0;
            } else {
              socket.write(Buffer.from([0x05, 0xFF]));
              socket.end();
            }
          } else {
            socket.write(Buffer.from([0x05, 0x00]));
            state = 'request';
            bufs = [buf.slice(2 + nmethods)]; bufLen = bufs[0].length;
          }
          return;
        }

        // ---- STATE: AUTH SUB-NEGOTIATION ----
        if (state === 'auth_sub' && bufLen >= 2) {
          const uLen = buf[1];
          if (bufLen < 2 + uLen + 1) return;
          const pLen = buf[2 + uLen];
          if (bufLen < 2 + uLen + 1 + pLen) return;
          const username = buf.slice(2, 2 + uLen).toString();
          const password = buf.slice(2 + uLen + 1, 2 + uLen + 1 + pLen).toString();

          if (authManager.validateSocks5Auth(username, password)) {
            socksUsername = username;
            socket.write(Buffer.from([0x01, 0x00]));
            state = 'request';
            bufs = [buf.slice(2 + uLen + 1 + pLen)]; bufLen = bufs[0].length;
          } else {
            socket.write(Buffer.from([0x01, 0x01]));
            socket.end();
          }
          return;
        }

        // ---- STATE: REQUEST ----
        if (state === 'request') {
          const b = Buffer.concat(bufs, bufLen);
          if (b.length < 5) return;
          const ver = b[0]; const cmd = b[1]; const atyp = b[3];
          if (ver !== 0x05) { socket.end(); return; }

          // Parse address
          let addrLen = 0, host = '';
          if (atyp === 0x01) addrLen = 4;
          else if (atyp === 0x03) addrLen = 1 + b[4];
          else if (atyp === 0x04) addrLen = 16;
          else { socket.write(encodeReply(0x08)); socket.end(); return; }

          const headerLen = 4 + addrLen + 2;
          if (b.length < headerLen) return;

          if (atyp === 0x01) {
            host = `${b[4]}.${b[5]}.${b[6]}.${b[7]}`;
          } else if (atyp === 0x03) {
            host = b.slice(5, 5 + b[4]).toString();
          } else {
            host = Array.from(b.slice(4, 20)).map(n => n.toString(16)).join(':');
          }
          const port = b[headerLen - 2] * 256 + b[headerLen - 1];

          if (cmd === 0x03) {
            // ---- UDP ASSOCIATE ----
            handleUDPAssociate(socket, b, atyp, host, port, clientManager, config, logger, cleanup);
            state = 'udp';
            bufs = []; bufLen = 0;
            return;
          }

          if (cmd !== 0x01) {
            socket.write(encodeReply(0x07)); socket.end(); return;
          }

          // ---- CONNECT ----
          handleTCPConnect(socket, host, port, clientManager, config, logger);
          state = 'tunnel'; bufs = []; bufLen = 0;
        }
      } catch (err) {
        logger.error({ error: err.message }, 'SOCKS5 protocol error');
        try { socket.end(); } catch (_) {}
        cleanup();
      }
    });

    socket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') logger.error({ error: err.message }, 'SOCKS5 socket error');
      cleanup();
    });
    socket.on('close', () => cleanup());
  });

  return server;
}

// =============================================================================
// TCP CONNECT (cmd = 0x01)
// =============================================================================
function handleTCPConnect(socket, host, port, clientManager, config, logger) {
  let tunnelId = uuidv4();
  let currentClient = null;
  let currentTimeout = null;

  // ACL check for TCP CONNECT
  if (clientManager.acl && !clientManager.acl.check(null, host, 'socks5', port, socket.remoteAddress || '')) {
    logger.warn({ targetHost: host, targetPort: port, ip: socket.remoteAddress }, 'ACL denied SOCKS5 CONNECT');
    socket.write(encodeReply(0x02)); socket.end(); return;
  }

  // Plugin hook: onTunnel
  if (clientManager.pluginManager && typeof clientManager.pluginManager.executeHook === 'function') {
    Promise.resolve(clientManager.pluginManager.executeHook('onTunnel', {
      socket, host, port,
      clientManager,
      ip: socket.remoteAddress || '',
      timestamp: Date.now(),
    })).catch(() => {});
  }

  const client = clientManager.selectClient();
  if (!client) {
    socket.write(encodeReply(0x01)); socket.end(); return;
  }

  if (client.pendingTunnels.size >= (config.client?.max_concurrent || 100)) {
    socket.write(encodeReply(0x01)); socket.end(); return;
  }

  currentClient = client;

  // Use StreamMux for tunnel if available
  if (client.mux) {
    const stream = client.mux.openTunnel(host, port, 128);
    if (!stream) {
      socket.write(encodeReply(0x01)); socket.end(); return;
    }

    tunnelId = stream.id;
    client.pendingTunnels.add(tunnelId);

    currentTimeout = setTimeout(() => {
      try { socket.write(encodeReply(0x03)); socket.end(); } catch (_) {}
      clientManager.trackError(client.id, 'tunnel_timeout');
    }, config.client.tunnel_timeout);

    clientManager.pendingTunnels.set(tunnelId, {
      type: 'socks5', socket, client, timeout: currentTimeout, startTime: Date.now(),
      stream,
      ip: String(socket.remoteAddress || '').replace(/^::ffff:/i, ''),
      host,
      port,
    });

    clientManager.trackTunnel(client.id);

    // Tunnel lifecycle (ready/data/close/error) is handled centrally in ws-server.js
    // via mux.onStream -> handleTunnelReady/handleTunnelData/handleTunnelClose/handleTunnelError
  } else {
    // Legacy JSON fallback
    const msg = { type: 'tunnel_open', id: tunnelId, host, port };
    client.ws.send(JSON.stringify(msg), (err) => {
      if (err) { socket.write(encodeReply(0x01)); socket.end(); return; }
    });

    currentTimeout = setTimeout(() => {
      try { socket.write(encodeReply(0x03)); socket.end(); } catch (_) {}
      clientManager.trackError(client.id, 'tunnel_timeout');
    }, config.client.tunnel_timeout);

    clientManager.pendingTunnels.set(tunnelId, {
      type: 'socks5', socket, client, timeout: currentTimeout, startTime: Date.now(),
      ip: String(socket.remoteAddress || '').replace(/^::ffff:/i, ''),
      host,
      port,
    });
    client.pendingTunnels.add(tunnelId);
    clientManager.trackTunnel(client.id);
  }
}

// =============================================================================
// UDP ASSOCIATE (cmd = 0x03) - RFC 1928 Section 7
// =============================================================================
function handleUDPAssociate(socket, requestBuf, atyp, clientHost, clientPort, clientManager, config, logger, cleanup) {
  // Bind a UDP port for the relay
  const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  // Store UDP relay info
  const assocId = uuidv4();
  const udpClients = new Map(); // key -> { socket, client }

  udpServer.on('message', (msg, rinfo) => {
    // Parse SOCKS5 UDP datagram header (RFC 1928 Section 7)
    // +----+------+------+----------+----------+----------+
    // |RSV | FRAG | ATYP | DST.ADDR | DST.PORT |   DATA   |
    // +----+------+------+----------+----------+----------+
    // |  2 |   1  |   1  | Variable |    2     | Variable |
    // +----+------+------+----------+----------+----------+
    if (msg.length < 4) return;

    const frag = msg[2];
    if (frag !== 0x00) {
      // Fragmentation not supported
      return;
    }

    const atyp = msg[3];
    let host = '', port = 0, addrLen = 0, dataStart = 0;

    if (atyp === 0x01) { // IPv4
      if (msg.length < 10) return;
      host = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
      port = msg[8] * 256 + msg[9];
      dataStart = 10;
    } else if (atyp === 0x03) { // Domain name
      if (msg.length < 7) return;
      const nameLen = msg[4];
      if (msg.length < 7 + nameLen) return;
      host = msg.slice(5, 5 + nameLen).toString();
      port = msg[5 + nameLen] * 256 + msg[5 + nameLen + 1];
      dataStart = 7 + nameLen;
    } else if (atyp === 0x04) { // IPv6
      if (msg.length < 22) return;
      host = Array.from(msg.slice(4, 20)).map(n => n.toString(16).padStart(2, '0')).join(':');
      port = msg[20] * 256 + msg[21];
      dataStart = 22;
    } else {
      return;
    }

    const data = msg.slice(dataStart);

    // Select a client to relay this UDP datagram
    const client = clientManager.selectClient();
    if (!client) return;

    // Check ACL
    if (clientManager.acl && !clientManager.acl.check(client, host, 'udp')) return;

    // Forward via WebSocket
    const udpId = uuidv4();
    const forwardMsg = {
      type: 'udp_data',
      id: udpId,
      assocId,
      host,
      port,
      // Original SOCKS5 UDP client address - needed to route the response back
      src: { address: rinfo.address, port: rinfo.port },
      data: data.toString('base64'),
    };

    client.ws.send(JSON.stringify(forwardMsg), (err) => {
      if (err) {
        clientManager.trackError(client.id, 'udp_send_error');
      }
    });

    // Track for response routing
    const key = `${rinfo.address}:${rinfo.port}`;
    udpClients.set(key, { rinfo, client });
  });

  // Handle UDP responses from the client (via WebSocket tunnel)
  clientManager.onUdpData = (msg) => {
    try {
      const data = Buffer.from(msg.data || '', 'base64');
      if (data.length === 0) return;

      // Find the association this response belongs to
      const assoc = clientManager.udpAssociations.get(msg.assocId);
      if (!assoc) return;
      const { udpServer, udpClients } = assoc;

      // Response must go back to the original SOCKS5 UDP client source address
      const rinfo = msg.src || msg.rinfo || { address: clientHost, port: clientPort };

      // Wrap in SOCKS5 UDP response header
      let respHeader;
      if (net.isIPv4(rinfo.address)) {
        const ip = rinfo.address.split('.').map(Number);
        respHeader = Buffer.alloc(10);
        respHeader[3] = 0x01;
        respHeader[4] = ip[0]; respHeader[5] = ip[1]; respHeader[6] = ip[2]; respHeader[7] = ip[3];
        respHeader[8] = (rinfo.port >> 8) & 0xFF;
        respHeader[9] = rinfo.port & 0xFF;
      } else {
        respHeader = Buffer.alloc(22);
        respHeader[3] = 0x04;
        const parts = rinfo.address.split(':');
        for (let i = 0; i < 8 && i < parts.length; i++) {
          respHeader[4 + i * 2] = parseInt(parts[i].substring(0, 2), 16) || 0;
          respHeader[4 + i * 2 + 1] = parseInt(parts[i].substring(2, 4), 16) || 0;
        }
        respHeader[20] = (rinfo.port >> 8) & 0xFF;
        respHeader[21] = rinfo.port & 0xFF;
      }

      const resp = Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), respHeader, data]);
      udpServer.send(resp, rinfo.port, rinfo.address, (err) => {
        if (err) logger.error({ error: err.message }, 'UDP response send error');
      });
    } catch (_) {}
  };

  udpServer.on('error', (err) => {
    logger.error({ error: err.message }, 'UDP ASSOCIATE error');
  });

  // Bind to a random port
  udpServer.bind(0, '0.0.0.0', () => {
    const udpPort = udpServer.address().port;
    logger.info({ udpPort, clientHost, clientPort }, 'SOCKS5 UDP ASSOCIATE established');

    // Send reply with the UDP relay address
    // BND.ADDR = 0.0.0.0, BND.PORT = udpPort
    const reply = Buffer.alloc(10);
    reply[0] = 0x05; reply[1] = 0x00; reply[2] = 0x00; reply[3] = 0x01;
    reply[8] = (udpPort >> 8) & 0xFF;
    reply[9] = udpPort & 0xFF;
    socket.write(reply);
  });

  // Store for cleanup
  clientManager.udpAssociations = clientManager.udpAssociations || new Map();
  clientManager.udpAssociations.set(assocId, { udpServer, udpClients, socket });
}

function encodeReply(replyCode) {
  const buf = Buffer.alloc(10);
  buf[0] = 0x05; buf[1] = replyCode; buf[2] = 0x00; buf[3] = 0x01;
  for (let i = 4; i < 10; i++) buf[i] = 0x00;
  return buf;
}

module.exports = { createSocks5Proxy };