// =============================================================================
// The node IP recorded at registration must omit the IPv4-mapped prefix (issue #206).
//
// The web port listens dual-stack ('::'), so an IPv4 peer is reported by Node as
// ::ffff:127.0.0.1. Until #162 the panel picked that address out of a proxy header
// (plain IPv4 text); after #162 it is the raw TCP peer, and without stripping the
// prefix the panel showed ::ffff:127.0.0.1 (visible on every compose deployment,
// which is dual-stack). Every other remoteAddress read in the proxy paths
// normalizes (proxy-http norm(), proxy-socks5 normalizeIp()) - this test drives
// the REAL registration code path over a REAL socket to pin the same rule for
// ws-server.
//
// Follows the harness style of client-session-ownership.test.ts: ClientManager
// double, silent logger, hand-wired upgrade on /ws.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type { Duplex as StreamDuplex } from 'stream';
import type { WebSocket as WsType } from 'ws';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const http = require('http');
const { WebSocket } = require('ws');
const { ClientManager } = require('../lib/client-manager.ts');
const { setupClientWebSocket } = require('../lib/ws-server.ts');

type LoggerLike = Record<string, unknown>;
function silentLogger(): LoggerLike {
  const logger: Record<string, unknown> = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  };
  logger.child = () => logger;
  return logger;
}

const CONFIG = {
  server: { host: '::' },
  health_check: {},
  client: {},
  mux: { initial_window: 65536, connection_window: 1048576 },
};

// Connects over a real socket to a real dual-stack listener, walks the actual
// auth + registration path, and returns the info.ip the server recorded for the
// node (read back through the live ClientManager, like the panel does).
// Mirrors the WssLike shape of client-session-ownership.test.ts: setupClientWebSocket
// returns the ws server; only the hand-wired upgrade matters here.
interface WssLike2 {
  handleUpgrade(req: unknown, socket: unknown, head: unknown, cb: (ws: unknown) => void): void;
  emit(event: string, ...args: unknown[]): void;
  // ws.WebSocketServer surface used elsewhere (never called in this test).
  clients?: unknown;
  options?: unknown;
}

async function registerOverSocket(t: { after(fn: () => void): void }, connectFrom: string, label: string): Promise<{ ip?: string }> {
  const httpServer = http.createServer();
  const manager = new ClientManager(CONFIG, silentLogger() as never);
  const wss: WssLike2 = setupClientWebSocket(
    httpServer,
    manager,
    { validateClientToken: (tk: string) => tk === 'k' },
    CONFIG,
    silentLogger() as never
  );

  httpServer.on('upgrade', (request: { url?: string }, socket: StreamDuplex, head: Buffer) => {
    if (request.url === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws: unknown) => wss.emit('connection', ws, request));
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => { httpServer.listen(0, '::', () => resolve()); });
  const port = (httpServer.address() as { port: number }).port;
  t.after(() => {
    for (const c of manager.clients.values()) { try { (c.ws as WsType & { terminate(): void }).terminate(); } catch (_) { /* ignore */ } }
    httpServer.close();
  });

  const ws: WsType = new WebSocket(`ws://${connectFrom.includes(':') ? '[' + connectFrom + ']' : connectFrom}:${port}/ws`);
  t.after(() => { try { ws.terminate(); } catch (_) { /* ignore */ } });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'k' })));
    ws.on('message', (raw: unknown, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth_ok') {
          ws.send(JSON.stringify({ type: 'info', info: { clientId: label, hostname: 't', supportsMux: false } }));
        }
        if (msg.type === 'info_ok') resolve();
      } catch (e) { reject(e as Error); }
    });
    ws.on('error', reject);
  });

  const node = manager.getById(label);
  return node ? { ip: (node.info.ip as string | undefined) } : {};
}

test('a dual-stack listener records an IPv4 peer without the ::ffff: prefix', async () => {
  const seen = await registerOverSocket(test, '127.0.0.1', 'v4-node');
  assert.equal(seen.ip, '127.0.0.1', `the panel would show ${seen.ip}; the mapping prefix must be stripped (issue #206)`);
});

test('a pure IPv6 peer keeps its original form', async () => {
  const seen = await registerOverSocket(test, '::1', 'v6-node');
  assert.equal(seen.ip, '::1', `an IPv6 peer must not be rewritten (got ${seen.ip})`);
});
