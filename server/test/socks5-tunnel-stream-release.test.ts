// =============================================================================
// A SOCKS5 tunnel must hand its mux stream back when the tunnel ends.
//
// The release lives in cleanup(), wired to the socket's close/error/timeout, and it can only find
// the stream through cleanupState.tunnelId / cleanupState.currentClient. Those two fields were
// never written, so the whole release was dead code - while the test that "covered" it asserted the
// source string of the closeTunnel() call and stayed green as every tunnel leaked a stream until
// the node's WebSocket closed. 512 tunnels later the mux refused every stream and every SOCKS5
// CONNECT failed with "openTunnel failed", with the node healthy and the window untouched
// (openStreams=512, pending=1-3, connectionSendWindow ~ 1MB: leak, not load, not flow control).
//
// So this drives the REAL listener over a REAL TCP socket with a REAL StreamMux behind a fake
// WebSocket, through the two ways a tunnel actually ends here:
//   1) the node never answers (this workload's unreachable/blackholed targets) -> tunnel_timeout;
//   2) the node answers with tunnel_error (refused / DNS failure / target timeout), dispatched by
//      the real ws-server dispatcher.
// Both must end with an empty mux.streams, which is what the 512 cap counts.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type * as NodeNet from 'net';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const net: typeof NodeNet = require('net');

type Handler = (...args: unknown[]) => void;

class FakeWsSocket {
  sent: Buffer[] = [];
  handlers = new Map<string, Handler>();
  readyState = 1;
  bufferedAmount = 0;

  send(data: unknown, _opts?: unknown, cb?: (err?: Error) => void): void {
    this.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    if (cb) cb();
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  close(): void {
    /* nothing to release */
  }

  // Deliver a frame to the mux exactly as the ws library would.
  deliver(frame: Buffer): void {
    const handler = this.handlers.get('message');
    if (!handler) throw new Error('the mux never registered a message handler');
    handler(frame, true);
  }
}

const FRAME_HEADER_SIZE = 13;

function encodeJsonFrame(type: number, streamId: number, obj: unknown, flags = 0): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt32BE(payload.length, 0);
  header[4] = type;
  header.writeUInt32BE(streamId, 5);
  header.writeUInt32BE(flags, 9);
  return Buffer.concat([header, payload]);
}

type StreamMuxLike = {
  streams: Map<number, unknown>;
  onStream(cb: (stream: unknown) => void): void;
  destroy?: () => void;
};
type MuxModule = {
  StreamMux: new (ws: unknown, options?: Record<string, unknown>) => StreamMuxLike;
  FRAME_TYPE: Record<string, number>;
  FLAG: Record<string, number>;
};

type SocksServer = {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
};
type Socks5Module = {
  createSocks5Proxy: (
    clientManager: unknown,
    authManager: unknown,
    config: unknown,
    logger: unknown,
    pluginManager: unknown
  ) => SocksServer;
};

type Dispatcher = (clientManager: unknown, stream: unknown, logger: unknown) => void;

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function loadMux(): Promise<MuxModule> {
  const ns = (await import('../../server/lib/stream-mux.ts')) as unknown as { default?: MuxModule };
  return ns.default ?? (ns as unknown as MuxModule);
}

async function loadSocks5(): Promise<Socks5Module> {
  const ns = (await import('../../server/lib/proxy-socks5.ts')) as unknown as { default?: Socks5Module };
  return ns.default ?? (ns as unknown as Socks5Module);
}

async function loadDispatcher(): Promise<Dispatcher> {
  const ns = (await import('../../server/lib/ws-server.ts')) as unknown as {
    default?: { dispatchClientStream?: Dispatcher };
    dispatchClientStream?: Dispatcher;
  };
  const mod = ns.default ?? (ns as unknown as { dispatchClientStream?: Dispatcher });
  assert.equal(typeof mod.dispatchClientStream, 'function', 'dispatchClientStream must be exported');
  return mod.dispatchClientStream as Dispatcher;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met in time');
}

// VER|CMD|RSV|ATYP|ADDR|PORT - a CONNECT to 127.0.0.1:443; the fake node never dials it.
function connectRequest(): Buffer {
  return Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xbb]);
}

// Frame types the mux sent, as { type, streamId, flags }: the flush batches small frames, so one
// WebSocket message is either a single frame or [2B count][frame]... - decode both, the same way
// the receiver does (StreamMux._handleFrame).
function decodeFrames(sent: Buffer[]): { type: number; streamId: number; flags: number }[] {
  const out: { type: number; streamId: number; flags: number }[] = [];
  for (const buf of sent) {
    if (buf.length < 13) continue;
    if (buf.readUInt16BE(0) >= 2) {
      let offset = 2;
      while (offset + 13 <= buf.length) {
        const length = buf.readUInt32BE(offset);
        if (offset + 13 + length > buf.length) break;
        out.push({ type: buf[offset + 4], streamId: buf.readUInt32BE(offset + 5), flags: buf.readUInt32BE(offset + 9) });
        offset += 13 + length;
      }
    } else {
      out.push({ type: buf[4], streamId: buf.readUInt32BE(5), flags: buf.readUInt32BE(9) });
    }
  }
  return out;
}

type Fixture = {
  server: SocksServer;
  port: number;
  mux: StreamMuxLike;
  ws: FakeWsSocket;
  client: Record<string, unknown>;
  pending: Map<string, unknown>;
  tunnelIds: Set<string>;
  close: () => Promise<void>;
};

// Boot the real listener with a fake node whose mux is real, and one SOCKS5 client connected
// through the greeting.
async function startProxy(tunnelTimeoutMs: number, withDispatcher: boolean): Promise<Fixture> {
  const { StreamMux } = await loadMux();
  const { createSocks5Proxy } = await loadSocks5();

  const ws = new FakeWsSocket();
  const mux = new StreamMux(ws, { connectionWindow: 1024 });
  const tunnelIds = new Set<string>();
  const client: Record<string, unknown> = {
    id: 'node-under-test',
    mux,
    pendingTunnels: tunnelIds,
    ws: { send: () => {} },
    tags: [],
  };
  const pending = new Map<string, unknown>();
  const clientManager = {
    acl: null,
    pluginManager: null,
    pendingTunnels: pending,
    pendingRequests: new Map<string, unknown>(),
    clients: new Map([[client.id, client]]),
    config: { client: { tunnel_timeout: tunnelTimeoutMs } },
    udpAssociations: new Map(),
    selectClient: () => client,
    isSaturated: () => false,
    trackTunnel: () => {},
    trackError: () => {},
    trackBytes: () => {},
    trackRequest: () => {},
    trackSuccess: () => {},
  };
  if (withDispatcher) {
    const dispatch = await loadDispatcher();
    mux.onStream((stream) => dispatch(clientManager, stream, silentLogger));
  }

  const authManager = { config: { auth: { proxy: { enabled: false } } }, resolveSocks5Auth: () => ({ ok: false }) };
  const config = { client: { tunnel_timeout: tunnelTimeoutMs } };

  const server = createSocks5Proxy(clientManager, authManager, config, silentLogger, null);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'the fake listener must be bound');
  const port = (address as { port: number }).port;

  return {
    server,
    port,
    mux,
    ws,
    client,
    pending,
    tunnelIds,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (mux.destroy) mux.destroy();
    },
  };
}

// Greeting + CONNECT to 127.0.0.1:443, returning the socket and everything it received.
async function openTunnel(port: number): Promise<{ sock: NodeNet.Socket; chunks: Buffer[] }> {
  const sock = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  sock.on('data', (chunk: Buffer) => chunks.push(chunk));
  sock.on('error', () => {});
  await new Promise<void>((resolve) => sock.once('connect', resolve));

  sock.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: SOCKS5, "no authentication"
  await waitFor(() => Buffer.concat(chunks).length >= 2, 5000);
  assert.deepEqual([...Buffer.concat(chunks).subarray(0, 2)], [0x05, 0x00], 'the greeting must be accepted');

  sock.write(connectRequest());
  return { sock, chunks };
}

test('a tunnel that the node never answers releases its stream on tunnel_timeout', async () => {
  // Long enough to observe the pending tunnel and its stream id even while the whole suite runs in
  // parallel; short enough to keep the test quick.
  const fixture = await startProxy(1200, false);
  const { FRAME_TYPE, FLAG } = await loadMux();
  const { sock, chunks } = await openTunnel(fixture.port);
  try {
    await waitFor(() => fixture.mux.streams.size === 1, 5000);
    const streamId = [...fixture.mux.streams.keys()][0];
    assert.equal(fixture.pending.size, 1, 'the tunnel is pending until the node answers');
    assert.equal(fixture.tunnelIds.size, 1, 'the client bookkeeping knows the tunnel');

    // The tunnel timeout fires, the reply goes out, the socket ends - and cleanup() must run with
    // the stream still recorded, or the entry stays in mux.streams forever.
    await waitFor(() => fixture.mux.streams.size === 0, 5000);
    assert.equal(
      fixture.mux.streams.size,
      0,
      'a timed-out tunnel must not keep its stream: leaked entries reach the 512 cap and every later SOCKS5 CONNECT fails'
    );
    assert.equal(fixture.pending.size, 0, 'and the pending slots must be gone');
    assert.equal(fixture.tunnelIds.size, 0, 'and the client bookkeeping too');
    const answered = Buffer.concat(chunks);
    assert.deepEqual(
      [...answered.subarray(answered.length - 10, answered.length - 8)],
      [0x05, 0x03],
      'and the SOCKS5 client must have been told the tunnel timed out (reply 0x03)'
    );

    // The NODE has to learn the tunnel is over. It ignores the TUNNEL_CLOSE frame (no branch for
    // it in either mux copy) and the legacy JSON tunnel_close is keyed by a string its numeric
    // tunnel map never matches, so END_STREAM is the only signal that releases its slot and
    // destroys the target socket. Without it every ended tunnel leaks one node slot until the node
    // reaches max_concurrent and answers "Client busy" to everything (2026-10-14: reported
    // occupancy 910 while the server held ~0 pending tunnels).
    // Frames are queued and flushed on a later setImmediate tick (stream-mux.ts
    // _sendFrame/_flushSendBuffer). `streams.size === 0` above only says closeTunnel()
    // ran; on a loaded CI runner the END_STREAM frame may not have been sent yet.
    const endStreamSent = () =>
      decodeFrames(fixture.ws.sent).some(
        (f) => f.streamId === streamId && f.type === FRAME_TYPE.DATA && (f.flags & FLAG.END_STREAM) !== 0
      );
    await waitFor(endStreamSent);
    assert.ok(
      endStreamSent(),
      'the node must be told the tunnel ended with END_STREAM, or it leaks a tunnel slot per ended tunnel'
    );
  } finally {
    sock.destroy();
    await fixture.close();
  }
});

test('a tunnel the node refuses releases its stream when the tunnel ends', async () => {
  const fixture = await startProxy(30000, true);
  const { FRAME_TYPE, FLAG } = await loadMux();
  const { sock, chunks } = await openTunnel(fixture.port);
  try {
    await waitFor(() => fixture.mux.streams.size === 1, 5000);
    const streamId = [...fixture.mux.streams.keys()][0];

    // The node reports the target failure on the tunnel's own stream, as client.ts does for an
    // unreachable target (the dominant case in the 2026-10 incident).
    fixture.ws.deliver(
      encodeJsonFrame(FRAME_TYPE.HEADERS, streamId, { type: 'tunnel_error', id: streamId, message: 'ECONNREFUSED' })
    );

    await waitFor(() => fixture.mux.streams.size === 0, 5000);
    assert.equal(fixture.mux.streams.size, 0, 'the ended tunnel must not keep its stream');
    // The greeting reply is 2 bytes, so the failure reply is the last 10.
    const answered = Buffer.concat(chunks);
    assert.equal(answered.length, 12, 'the client must have got the greeting reply and the tunnel failure');
    assert.deepEqual(
      [...answered.subarray(2, 4)],
      [0x05, 0x01],
      'and the node-reported failure must reach it as reply 0x01'
    );
    const endStreamSent = () =>
      decodeFrames(fixture.ws.sent).some(
        (f) => f.streamId === streamId && f.type === FRAME_TYPE.DATA && (f.flags & FLAG.END_STREAM) !== 0
      );
    await waitFor(endStreamSent);
    assert.ok(
      endStreamSent(),
      'and the node must still be told the tunnel ended, or it leaks its slot for a failed tunnel'
    );
  } finally {
    sock.destroy();
    await fixture.close();
  }
});
