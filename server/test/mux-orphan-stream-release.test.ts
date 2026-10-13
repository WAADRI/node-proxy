// =============================================================================
// A late client frame must not resurrect a mux stream the server already retired.
//
// StreamMux registers a stream for ANY id an incoming HEADERS frame carries, because the client
// half needs that to learn about server-initiated requests. On the server side every stream is
// opened by the server, so when a frame names an id that has no pending tunnel/request behind it
// the stream was already retired (the SOCKS5 socket ended, the tunnel timed out, the HTTP request
// was aborted). The old dispatcher created the entry and then returned early - "if (!p) return" -
// leaving a stream that nothing would ever remove again.
//
// 2026-10-13: those entries crept up to MAX_CONCURRENT_STREAMS and every later SOCKS5 CONNECT
// failed with "openTunnel failed" for hours, while the node reported far fewer active tunnels than
// its own limit. This test drives the REAL dispatcher (dispatchClientStream) through a REAL
// StreamMux and a fake WebSocket, so the ownership rule is exercised as behaviour, not as a
// source-string invariant; the wiring half (the mux callback really calls the dispatcher) can only
// be seen in the source, so it is asserted separately at the end.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type * as NodeFs from 'fs';
import type * as NodePath from 'path';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const fs: typeof NodeFs = require('fs');
const path: typeof NodePath = require('path');

type Handler = (...args: unknown[]) => void;

class FakeSocket {
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

  // Frame types the mux sent, as { type, streamId }. The flush batches small frames, so a single
  // WebSocket message is either one frame or [2B count][frame]... - decode both, the same way the
  // receiver does (StreamMux._handleFrame).
  frames(): { type: number; streamId: number }[] {
    const out: { type: number; streamId: number }[] = [];
    for (const buf of this.sent) {
      if (buf.length < 13) continue;
      if (buf.readUInt16BE(0) >= 2) {
        let offset = 2;
        while (offset + 13 <= buf.length) {
          const length = buf.readUInt32BE(offset);
          if (offset + 13 + length > buf.length) break;
          out.push({ type: buf[offset + 4], streamId: buf.readUInt32BE(offset + 5) });
          offset += 13 + length;
        }
      } else {
        out.push({ type: buf[4], streamId: buf.readUInt32BE(5) });
      }
    }
    return out;
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

// The SOCKS5 socket of a pending tunnel: enough of NetSocket for the real handlers.
class FakePeer {
  written: Buffer[] = [];
  handlers = new Map<string, Handler>();
  destroyed = false;
  writableEnded = false;

  write(data: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    return true;
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  end(): void {
    this.writableEnded = true;
  }
}

type StreamLike = { id: number; state?: string; sendData(data: Buffer, endStream: boolean): boolean };
type MuxLike = {
  streams: Map<number, unknown>;
  createStream(): StreamLike | null;
  openTunnel(host: string, port: number, priority?: number): StreamLike | null;
  closeTunnel(streamId: number, reason?: number | string): void;
  onStream(cb: (stream: StreamLike) => void): void;
  destroy?: () => void;
};
type MuxModule = { StreamMux: new (ws: unknown, options?: Record<string, unknown>) => MuxLike; FRAME_TYPE: Record<string, number> };

type Dispatcher = (clientManager: unknown, stream: unknown, logger: unknown) => void;

// Everything the handlers touch on the manager, plus the dispatcher's ownership maps.
function fakeManager(): Record<string, unknown> {
  return {
    pendingTunnels: new Map<string, unknown>(),
    pendingRequests: new Map<string, unknown>(),
    config: {},
    trackSuccess: () => {},
    trackError: () => {},
    trackBytes: () => {},
  };
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Let the mux's setImmediate-based frame flush run: _sendFrame queues and flushes on the next
// tick, so nothing is on the wire synchronously after a delivered frame.
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function loadMux(): Promise<MuxModule> {
  // ESM export syntax => dynamic import (a require() would throw "Unexpected token 'export'").
  const ns = (await import('../../server/lib/stream-mux.ts')) as unknown as { default?: MuxModule };
  return ns.default ?? (ns as unknown as MuxModule);
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

test('a late tunnel_ready cannot resurrect a retired stream (the 2026-10-13 leak)', async () => {
  const { StreamMux, FRAME_TYPE } = await loadMux();
  const dispatch = await loadDispatcher();
  const socket = new FakeSocket();
  const mux = new StreamMux(socket, { connectionWindow: 1024 });
  const manager = fakeManager();
  mux.onStream((stream) => dispatch(manager, stream, silentLogger));

  try {
    // One SOCKS5 tunnel as proxy-socks5 opens it, then the client socket goes away before the node
    // answers: cleanup() hands the mux stream back (the #213 fix).
    const first = mux.openTunnel('example.com', 80);
    assert.ok(first, 'the mux must open a tunnel');
    const retiredId = first.id;
    assert.equal(mux.streams.size, 1, 'the tunnel must be registered');
    mux.closeTunnel(retiredId, 'socks5_closed');
    assert.equal(mux.streams.size, 0, 'ending the tunnel must release its stream');

    // The node's answer then arrives on that retired id.
    socket.deliver(encodeJsonFrame(FRAME_TYPE.HEADERS, retiredId, { type: 'tunnel_ready', id: retiredId }));
    await settle();
    assert.equal(
      mux.streams.size,
      0,
      'a HEADERS frame for an id with no pending owner must not stay in the table: that entry is never removed again'
    );
    assert.ok(
      socket.frames().some((f) => f.type === FRAME_TYPE.RST_STREAM && f.streamId === retiredId),
      'and the node must be told to drop it, or it keeps the target socket open forever'
    );

    // The same door, opened repeatedly: the table must not creep towards the cap that makes every
    // later SOCKS5 CONNECT fail with "openTunnel failed".
    for (let i = 0; i < 600; i++) {
      const id = mux.openTunnel('example.com', 80);
      assert.ok(id, 'opening the tunnel must keep working (stream ' + i + ')');
      mux.closeTunnel(id.id, 'socks5_closed');
      socket.deliver(encodeJsonFrame(FRAME_TYPE.HEADERS, id.id, { type: 'tunnel_ready', id: id.id }));
    }
    await settle();
    assert.equal(mux.streams.size, 0, '600 late answers must leave the table empty, not at the 512 cap');
    assert.ok(mux.openTunnel('example.com', 80), 'and a new tunnel must still be openable');
  } finally {
    if (mux.destroy) mux.destroy();
  }
});

test('a response for an aborted request is retired too', async () => {
  const { StreamMux, FRAME_TYPE } = await loadMux();
  const dispatch = await loadDispatcher();
  const socket = new FakeSocket();
  const mux = new StreamMux(socket, { connectionWindow: 1024 });
  const manager = fakeManager();
  mux.onStream((stream) => dispatch(manager, stream, silentLogger));

  try {
    // proxy-http opens a stream per request; an aborted request releases it.
    const stream = mux.createStream();
    assert.ok(stream, 'the request stream must be created');
    const id = stream.id;
    mux.closeTunnel(id, 'request_aborted');
    assert.equal(mux.streams.size, 0);

    socket.deliver(encodeJsonFrame(FRAME_TYPE.HEADERS, id, { type: 'response', id: 'req-1', statusCode: 200 }));
    await settle();
    assert.equal(mux.streams.size, 0, 'a late response must not hold a stream nobody will ever close');
  } finally {
    if (mux.destroy) mux.destroy();
  }
});

test('a live tunnel_ready still reaches its pending tunnel', async () => {
  const { StreamMux, FRAME_TYPE } = await loadMux();
  const dispatch = await loadDispatcher();
  const socket = new FakeSocket();
  const mux = new StreamMux(socket, { connectionWindow: 1024 });
  const manager = fakeManager();
  mux.onStream((stream) => dispatch(manager, stream, silentLogger));

  try {
    const peer = new FakePeer();
    const stream = mux.openTunnel('example.com', 443);
    assert.ok(stream, 'the mux must open a tunnel');
    const id = stream.id;
    (manager.pendingTunnels as Map<string, unknown>).set(String(id), {
      type: 'socks5',
      socket: peer,
      client: null,
      timeout: null,
      startTime: Date.now(),
    });

    socket.deliver(encodeJsonFrame(FRAME_TYPE.HEADERS, id, { type: 'tunnel_ready', id }));

    const reply = peer.written[0];
    assert.ok(reply && reply.length >= 10, 'the SOCKS5 client must get its success reply');
    assert.deepEqual([...reply.subarray(0, 4)], [0x05, 0x00, 0x00, 0x01], 'and it must be a SOCKS5 success reply');
    assert.equal(mux.streams.size, 1, 'an owned stream must stay in the table');
    await settle();
    assert.ok(
      !socket.frames().some((f) => f.type === FRAME_TYPE.RST_STREAM && f.streamId === id),
      'an owned tunnel must not be reset'
    );
  } finally {
    if (mux.destroy) mux.destroy();
  }
});

test('the mux callback dispatches through the ownership rule (wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ws-server.ts'), 'utf8');
  assert.ok(
    /dispatchClientStream\(clientManager, stream, logger\);/.test(src),
    'the mux onStream callback must call the dispatcher, not a copy of the old dispatch chain'
  );
  assert.ok(
    /releaseOrphanStream\(stream, logger, type\)/.test(src) &&
      /releaseOrphanStream\(stream, logger, 'response'\)/.test(src),
    'both orphan doors (tunnel frames and HTTP responses) must be closed'
  );
});
