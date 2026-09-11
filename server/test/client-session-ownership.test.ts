// =============================================================================
// Regression tests for client session ownership (server side).
//
// A stale socket's 'close' can fire AFTER the same clientId has re-registered on
// a fresh socket - typically when a node restarts: the old TCP connection is
// still being torn down while the new one has already sent 'info'. The close
// handler used to call clientManager.remove(clientId) unguarded, which deleted
// the LIVE registration while its connection stayed open. The node then kept
// heart-beating into a session the server had forgotten and never recovered on
// its own: its own logs looked healthy, the panel showed it disconnected, and
// only a manual restart brought it back.
// =============================================================================
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

import type { WebSocket as WsClient, RawData } from 'ws';
import type { ClientManager as ClientManagerClass } from '../lib/client-manager.ts';

export type {};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');
const { ClientManager } = require('../lib/client-manager.ts');
const { setupClientWebSocket } = require('../lib/ws-server.ts');

const CLIENT_ID = 'test-node-ownership';

const CONFIG = {
  mux: { initial_window: 65536, connection_window: 1048576 },
  client: { tunnel_idle_timeout: 0 },
  health_check: { ping_interval: 10000, ping_timeout: 5000, max_failures: 3 },
};

interface AfterHook {
  after: (fn: () => void) => void;
}

interface WssLike {
  handleUpgrade(req: unknown, socket: unknown, head: unknown, cb: (ws: unknown) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

interface TestContext {
  port: number;
  manager: ClientManagerClass;
  sockets: WsClient[];
}

function silentLogger(): Record<string, unknown> {
  const noop = (): void => {};
  const logger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  logger.child = () => logger;
  return logger;
}

async function startServer(t: AfterHook): Promise<TestContext> {
  const httpServer = http.createServer();
  const manager = new ClientManager(CONFIG, silentLogger());
  const wss: WssLike = setupClientWebSocket(
    httpServer,
    manager,
    { validateClientToken: () => true },
    CONFIG,
    silentLogger()
  );

  // Mirrors server.ts: the returned WebSocketServer is hand-wired to the HTTP
  // upgrade event (the client connects on /ws).
  httpServer.on('upgrade', (request: unknown, socket: unknown, head: unknown) => {
    wss.handleUpgrade(request, socket, head, (ws: unknown) => {
      wss.emit('connection', ws, request);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const sockets: WsClient[] = [];

  t.after(() => {
    for (const socket of sockets) {
      try {
        socket.terminate();
      } catch (_) {
        // ignore
      }
    }
    httpServer.close();
  });

  return { port, manager, sockets };
}

// Connects, authenticates and registers with `clientId`; resolves once the
// server acknowledged the registration.
function connectAndRegister(ctx: TestContext, clientId: string): Promise<WsClient> {
  return new Promise<WsClient>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`) as WsClient;
    ctx.sockets.push(ws);

    ws.on('error', (err: Error) => reject(err));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
    });
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: { type?: string };
      try {
        msg = JSON.parse(raw.toString()) as { type?: string };
      } catch (_) {
        return;
      }
      if (msg.type === 'auth_ok') {
        ws.send(
          JSON.stringify({
            type: 'info',
            info: { clientId, hostname: 'test-host', supportsMux: false },
          })
        );
      } else if (msg.type === 'info_ok') {
        resolve(ws);
      }
    });
  });
}

function waitForClose(ws: WsClient, timeoutMs = 5000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`socket was not closed within ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test('a replaced connection closing late must not delete the new registration', async (t: AfterHook) => {
  const ctx = await startServer(t);

  const first = await connectAndRegister(ctx, CLIENT_ID);
  if (!ctx.manager.getById(CLIENT_ID)) throw new Error('first connection should be registered');

  // Registering a second connection with the same id replaces the first one.
  const second = await connectAndRegister(ctx, CLIENT_ID);
  assert.equal(await waitForClose(first), 4000, 'the replaced connection is closed with 4000');

  // Let the stale 'close' event fire now that the new registration exists.
  await delay(200);

  const current = ctx.manager.getById(CLIENT_ID);
  if (!current) throw new Error('registration must survive the replaced socket closing');
  assert.equal(second.readyState, WebSocket.OPEN, 'the live connection must stay open');

  // The live socket still owns the session: its heartbeat refreshes lastPing.
  const before = current.lastPing;
  await delay(10);
  second.send(JSON.stringify({ type: 'heartbeat' }));
  await delay(150);

  const after = ctx.manager.getById(CLIENT_ID);
  if (!after) throw new Error('a heartbeat must not evict the live session');
  assert.ok(after.lastPing > before, 'the heartbeat is attributed to the live socket');
});

test('a heartbeat from a session the server no longer knows closes the socket', async (t: AfterHook) => {
  const ctx = await startServer(t);
  const ws = await connectAndRegister(ctx, CLIENT_ID);

  // Reproduce what a health-check removal leaves behind: the socket is still
  // open while the registration is gone. Only 'info' can re-register a client,
  // so without a forced close the node would sit there forever.
  ctx.manager.remove(CLIENT_ID, 'test_forced_removal');
  assert.equal(ctx.manager.getById(CLIENT_ID), null, 'the registration is gone');

  const closed = waitForClose(ws);
  ws.send(JSON.stringify({ type: 'heartbeat' }));
  assert.equal(await closed, 4002, 'the server drops the unregistered session');
});
