// =============================================================================
// SOCKS5 Proxy v3.0 - Full SOCKS5 with UDP ASSOCIATE + IPv6
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; loaded by
// require('./lib/proxy-socks5.ts') under Node >= 24 type stripping.
// =============================================================================

import net from 'net';
import type { Socket as NetSocket } from 'net';
import dgram from 'dgram';
import type { RemoteInfo } from 'dgram';
import { v4 as uuidv4 } from 'uuid';
import type { ClientManager, ClientNode } from './client-manager.ts';
import type { ServerConfig } from './config.ts';
import type { AppLogger } from './logger.ts';

interface AuthManagerLike {
  config: { auth: { proxy: { enabled: boolean } } };
  validateSocks5Auth(username: string, password: string): boolean;
}

interface CleanupState {
  tunnelId: string | number | null;
  currentClient: ClientNode | null;
  currentTimeout: ReturnType<typeof setTimeout> | null;
  udpSocket: dgram.Socket | null;
}

type CleanupFn = () => void;

// Write only while the proxied socket is still open; a tunnel timeout racing
// a client disconnect would otherwise emit 'write after end'.
function safeWrite(socket: NetSocket, data: Buffer): boolean {
  if (socket.destroyed || socket.writableEnded) return false;
  try {
    socket.write(data);
    return true;
  } catch (_) {
    return false;
  }
}

export function createSocks5Proxy(
  clientManager: ClientManager,
  authManager: AuthManagerLike,
  config: ServerConfig,
  logger: AppLogger,
  _pluginManager: { executeHook(hook: string, context: Record<string, unknown>): unknown } | null
) {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let state: 'greeting' | 'auth_sub' | 'request' | 'tunnel' | 'udp' = 'greeting';
    let bufs: Buffer[] = [];
    let bufLen = 0;
    const cleanupState: CleanupState = {
      tunnelId: null,
      currentClient: null,
      currentTimeout: null,
      udpSocket: null,
    };

    function cleanup() {
      if (cleanupState.currentTimeout) clearTimeout(cleanupState.currentTimeout);
      if (cleanupState.tunnelId && cleanupState.currentClient) {
        cleanupState.currentClient.pendingTunnels.delete(cleanupState.tunnelId);
        clientManager.pendingTunnels.delete(cleanupState.tunnelId);
        try {
          cleanupState.currentClient.ws.send(JSON.stringify({ type: 'tunnel_close', id: cleanupState.tunnelId }));
        } catch (_) {
          // ignore
        }
      }
      if (cleanupState.udpSocket) {
        try {
          cleanupState.udpSocket.close();
        } catch (_) {
          // ignore
        }
        cleanupState.udpSocket = null;
      }
    }

    socket.on('data', (data: Buffer) => {
      // Handshake complete: this parser is done. Tunnel/UDP traffic is
      // forwarded by ws-server listeners; never buffer or re-parse it here,
      // otherwise every chunk would be appended to `bufs` and re-concatenated
      // (memory grows with traffic, O(n^2) copies) — see issue #33.
      if (state === 'tunnel' || state === 'udp') return;

      bufs.push(data);
      bufLen += data.length;
      const buf = Buffer.concat(bufs, bufLen);

      try {
        // ---- STATE: GREETING ----
        if (state === 'greeting' && bufLen >= 2) {
          const ver = buf[0];
          const nmethods = buf[1];
          if (bufLen < 2 + nmethods) return;
          if (ver !== 0x05) {
            socket.end();
            return;
          }

          const proxyAuth = authManager.config.auth.proxy;
          const methods: number[] = [];
          for (let i = 0; i < nmethods; i++) methods.push(buf[2 + i]);

          if (proxyAuth.enabled) {
            if (methods.includes(0x02)) {
              socket.write(Buffer.from([0x05, 0x02]));
              state = 'auth_sub';
              bufs = [];
              bufLen = 0;
            } else {
              socket.write(Buffer.from([0x05, 0xff]));
              socket.end();
            }
          } else {
            socket.write(Buffer.from([0x05, 0x00]));
            state = 'request';
            bufs = [buf.slice(2 + nmethods)];
            bufLen = bufs[0].length;
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
            socket.write(Buffer.from([0x01, 0x00]));
            state = 'request';
            bufs = [buf.slice(2 + uLen + 1 + pLen)];
            bufLen = bufs[0].length;
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
          const ver = b[0];
          const cmd = b[1];
          const atyp = b[3];
          if (ver !== 0x05) {
            socket.end();
            return;
          }

          // Parse address
          let addrLen = 0;
          let host = '';
          if (atyp === 0x01) addrLen = 4;
          else if (atyp === 0x03) addrLen = 1 + b[4];
          else if (atyp === 0x04) addrLen = 16;
          else {
            socket.write(encodeReply(0x08));
            socket.end();
            return;
          }

          const headerLen = 4 + addrLen + 2;
          if (b.length < headerLen) return;

          if (atyp === 0x01) {
            host = `${b[4]}.${b[5]}.${b[6]}.${b[7]}`;
          } else if (atyp === 0x03) {
            host = b.slice(5, 5 + b[4]).toString();
          } else {
            host = Array.from(b.slice(4, 20))
              .map((n) => n.toString(16))
              .join(':');
          }
          const port = b[headerLen - 2] * 256 + b[headerLen - 1];

          if (cmd === 0x03) {
            // ---- UDP ASSOCIATE ----
            handleUDPAssociate(socket, b, atyp, host, port, clientManager, config, logger, cleanup);
            state = 'udp';
            bufs = [];
            bufLen = 0;
            return;
          }

          if (cmd !== 0x01) {
            socket.write(encodeReply(0x07));
            socket.end();
            return;
          }

          // ---- CONNECT ----
          handleTCPConnect(socket, host, port, clientManager, config, logger);
          state = 'tunnel';
          bufs = [];
          bufLen = 0;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ error: message }, 'SOCKS5 protocol error');
        try {
          socket.end();
        } catch (_) {
          // ignore
        }
        cleanup();
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
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
function handleTCPConnect(
  socket: NetSocket,
  host: string,
  port: number,
  clientManager: ClientManager,
  config: ServerConfig,
  logger: AppLogger
) {
  let tunnelId: string | number = uuidv4();
  let currentTimeout: ReturnType<typeof setTimeout> | null = null;

  // ACL check for TCP CONNECT
  if (clientManager.acl && !clientManager.acl.check(null, host, 'socks5', port, socket.remoteAddress || '')) {
    logger.warn({ targetHost: host, targetPort: port, ip: socket.remoteAddress }, 'ACL denied SOCKS5 CONNECT');
    socket.write(encodeReply(0x02));
    socket.end();
    return;
  }

  // Plugin hook: onTunnel
  if (clientManager.pluginManager && typeof clientManager.pluginManager.executeHook === 'function') {
    Promise.resolve(
      clientManager.pluginManager.executeHook('onTunnel', {
        socket,
        host,
        port,
        clientManager,
        ip: socket.remoteAddress || '',
        timestamp: Date.now(),
      })
    ).catch(() => {});
  }

  const client = clientManager.selectClient();
  if (!client) {
    socket.write(encodeReply(0x01));
    socket.end();
    return;
  }

  if (client.pendingTunnels.size >= (config.client?.max_concurrent || 100)) {
    socket.write(encodeReply(0x01));
    socket.end();
    return;
  }

  // Use StreamMux for tunnel if available
  if (client.mux) {
    const stream = client.mux.openTunnel(host, port, 128);
    if (!stream) {
      socket.write(encodeReply(0x01));
      socket.end();
      return;
    }

    tunnelId = stream.id;
    client.pendingTunnels.add(tunnelId);

    currentTimeout = setTimeout(() => {
      safeWrite(socket, encodeReply(0x03));
      try {
        socket.end();
      } catch (_) {
        // ignore
      }
      clientManager.trackError(client.id, 'tunnel_timeout');
    }, config.client.tunnel_timeout);

    clientManager.pendingTunnels.set(tunnelId, {
      type: 'socks5',
      socket,
      client,
      timeout: currentTimeout,
      startTime: Date.now(),
      stream,
      ip: String(socket.remoteAddress || '').replace(/^::ffff:/i, ''),
      host,
      port,
    });

    clientManager.trackTunnel(client.id);

    // Tunnel lifecycle (ready/data/close/error) is handled centrally in ws-server
    // via mux.onStream -> handleTunnelReady/handleTunnelData/handleTunnelClose/handleTunnelError
  } else {
    // Legacy JSON fallback
    const msg = { type: 'tunnel_open', id: tunnelId, host, port };
    client.ws.send(JSON.stringify(msg), (err) => {
      if (err) {
        safeWrite(socket, encodeReply(0x01));
        try {
          socket.end();
        } catch (_) {
          // ignore
        }
        return;
      }
    });

    currentTimeout = setTimeout(() => {
      safeWrite(socket, encodeReply(0x03));
      try {
        socket.end();
      } catch (_) {
        // ignore
      }
      clientManager.trackError(client.id, 'tunnel_timeout');
    }, config.client.tunnel_timeout);

    clientManager.pendingTunnels.set(tunnelId, {
      type: 'socks5',
      socket,
      client,
      timeout: currentTimeout,
      startTime: Date.now(),
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
function handleUDPAssociate(
  socket: NetSocket,
  requestBuf: Buffer,
  atyp: number,
  clientHost: string,
  clientPort: number,
  clientManager: ClientManager,
  config: ServerConfig,
  logger: AppLogger,
  _cleanup: CleanupFn
) {
  void requestBuf;
  void atyp;
  // Bind a UDP port for the relay
  const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  // Store UDP relay info
  const assocId = uuidv4();
  const udpClients = new Map<string, { rinfo: RemoteInfo; client: ClientNode }>();

  udpServer.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    // Parse SOCKS5 UDP datagram header (RFC 1928 Section 7)
    if (msg.length < 4) return;

    const frag = msg[2];
    if (frag !== 0x00) {
      // Fragmentation not supported
      return;
    }

    const msgAtyp = msg[3];
    let host = '';
    let port = 0;
    let dataStart = 0;

    if (msgAtyp === 0x01) {
      // IPv4
      if (msg.length < 10) return;
      host = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
      port = msg[8] * 256 + msg[9];
      dataStart = 10;
    } else if (msgAtyp === 0x03) {
      // Domain name
      if (msg.length < 7) return;
      const nameLen = msg[4];
      if (msg.length < 7 + nameLen) return;
      host = msg.slice(5, 5 + nameLen).toString();
      port = msg[5 + nameLen] * 256 + msg[5 + nameLen + 1];
      dataStart = 7 + nameLen;
    } else if (msgAtyp === 0x04) {
      // IPv6
      if (msg.length < 22) return;
      host = Array.from(msg.slice(4, 20))
        .map((n) => n.toString(16).padStart(2, '0'))
        .join(':');
      port = msg[20] * 256 + msg[21];
      dataStart = 22;
    } else {
      return;
    }

    const data = msg.slice(dataStart);

    // Select a client to relay this UDP datagram
    const client = clientManager.selectClient();
    if (!client) return;

    // Check ACL (legacy first arg is the client object, not an id)
    if (clientManager.acl && !clientManager.acl.check(client, host, 'udp')) {
      return;
    }

    // Forward via WebSocket
    const udpId = uuidv4();
    const forwardMsg: Record<string, unknown> = {
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
  clientManager.onUdpData = (msg: Record<string, unknown>) => {
    try {
      const data = Buffer.from(typeof msg.data === 'string' ? msg.data : '', 'base64');
      if (data.length === 0) return;

      // Find the association this response belongs to
      const assoc = clientManager.udpAssociations?.get(String(msg.assocId || ''));
      if (!assoc) return;
      const assocUdp = assoc.udpServer as dgram.Socket;
      const assocClients = assoc.udpClients as Map<string, { rinfo: RemoteInfo; client: ClientNode }>;

      // Response must go back to the original SOCKS5 UDP client source address
      const srcObj = msg.src && typeof msg.src === 'object' ? (msg.src as Record<string, unknown>) : null;
      const rinfo: { address: string; port: number } = {
        address: srcObj && typeof srcObj.address === 'string' ? srcObj.address : clientHost,
        port: srcObj && typeof srcObj.port === 'number' ? srcObj.port : clientPort,
      };
      void assocClients;

      // Wrap in SOCKS5 UDP response header
      let respHeader: Buffer;
      if (net.isIPv4(rinfo.address)) {
        const ip = rinfo.address.split('.').map(Number);
        respHeader = Buffer.alloc(10);
        respHeader[3] = 0x01;
        respHeader[4] = ip[0];
        respHeader[5] = ip[1];
        respHeader[6] = ip[2];
        respHeader[7] = ip[3];
        respHeader[8] = (rinfo.port >> 8) & 0xff;
        respHeader[9] = rinfo.port & 0xff;
      } else {
        respHeader = Buffer.alloc(22);
        respHeader[3] = 0x04;
        const parts = rinfo.address.split(':');
        for (let i = 0; i < 8 && i < parts.length; i++) {
          respHeader[4 + i * 2] = parseInt(parts[i].substring(0, 2), 16) || 0;
          respHeader[4 + i * 2 + 1] = parseInt(parts[i].substring(2, 4), 16) || 0;
        }
        respHeader[20] = (rinfo.port >> 8) & 0xff;
        respHeader[21] = rinfo.port & 0xff;
      }

      const resp = Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), respHeader, data]);
      assocUdp.send(resp, rinfo.port, rinfo.address, (err) => {
        if (err) logger.error({ error: err.message }, 'UDP response send error');
      });
    } catch (_) {
      // ignore
    }
  };

  udpServer.on('error', (err: NodeJS.ErrnoException) => {
    logger.error({ error: err.message }, 'UDP ASSOCIATE error');
  });

  // Bind to a random port
  udpServer.bind(0, '0.0.0.0', () => {
    const udpPort = udpServer.address().port;
    logger.info({ udpPort, clientHost, clientPort }, 'SOCKS5 UDP ASSOCIATE established');

    // Send reply with the UDP relay address
    // BND.ADDR = 0.0.0.0, BND.PORT = udpPort
    const reply = Buffer.alloc(10);
    reply[0] = 0x05;
    reply[1] = 0x00;
    reply[2] = 0x00;
    reply[3] = 0x01;
    reply[8] = (udpPort >> 8) & 0xff;
    reply[9] = udpPort & 0xff;
    safeWrite(socket, reply);
  });

  // Store for cleanup
  clientManager.udpAssociations = clientManager.udpAssociations || new Map();
  clientManager.udpAssociations.set(assocId, { udpServer, udpClients, socket });
}

function encodeReply(replyCode: number): Buffer {
  const buf = Buffer.alloc(10);
  buf[0] = 0x05;
  buf[1] = replyCode;
  buf[2] = 0x00;
  buf[3] = 0x01;
  for (let i = 4; i < 10; i++) buf[i] = 0x00;
  return buf;
}
