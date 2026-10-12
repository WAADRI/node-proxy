// =============================================================================
// Flow control, driven by a FAKE PEER (recommendation from the third-party review).
//
// Three rounds of review found real runtime defects in code whose source-invariant tests were
// green (double dispatch, dropped UDP packets, a bcrypt import that threw on every login). The
// recommended remedy is a behaviour test with a fake peer on the risky paths - the mux is one of
// them, so this test drives a REAL StreamMux through a fake WebSocket:
//   * the fake records everything the mux sends;
//   * feeding a frame back is just calling the 'message' handler the mux registered.
//
// It then asserts the connection-window properties that source-string tests cannot see:
//   1) an invalid WINDOW_UPDATE increment is ignored (PR #180);
//   2) a valid one credits the window;
//   3) sending DATA debits it (PR #189);
//   4) an exhausted window makes the flush stop, and a later WINDOW_UPDATE RESUMES it - without
//      that resume, a quiet stream would wait forever (also PR #189).
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');

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

  bytesSent(): number {
    return this.sent.reduce((n, b) => n + b.length, 0);
  }
}

const FRAME_HEADER_SIZE = 13;

function encodeFrame(type: number, streamId: number, payload: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt32BE(payload.length, 0);
  header[4] = type;
  header.writeUInt32BE(streamId, 5);
  header.writeUInt32BE(flags, 9);
  return Buffer.concat([header, payload]);
}

function encodeJsonFrame(type: number, streamId: number, obj: unknown, flags = 0): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(obj), 'utf8'), flags);
}

type StreamLike = { sendData(data: Buffer, endStream: boolean): boolean };
type MuxLike = {
  connectionSendWindow: number;
  createStream(): StreamLike | null;
  destroy?: () => void;
};
type StreamMuxCtor = new (ws: unknown, options?: Record<string, unknown>) => MuxLike;
type MuxModule = { StreamMux: StreamMuxCtor; FRAME_TYPE: Record<string, number> };

async function loadMux(): Promise<MuxModule> {
  // The module uses ESM export syntax, so it must be imported dynamically (a require() of it
  // would throw "Unexpected token 'export'" - the very trap that broke the client in PR #179).
  const ns = (await import('../../server/lib/stream-mux.ts')) as unknown as { default?: MuxModule };
  return ns.default ?? (ns as unknown as MuxModule);
}

// Let the mux's setImmediate-based flush run.
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('the connection window is credited, debited, and drives a stall that resumes', async () => {
  const { StreamMux, FRAME_TYPE } = await loadMux();
  const socket = new FakeSocket();
  const mux = new StreamMux(socket, { connectionWindow: 1024 });

  try {
    const start = mux.connectionSendWindow;
    assert.equal(start, 1024, 'the test window must be in effect');

    // 1) An invalid increment is ignored - otherwise a peer could hand itself an unlimited window.
    socket.deliver(encodeJsonFrame(FRAME_TYPE.WINDOW_UPDATE, 0, { increment: -4096 }));
    assert.equal(mux.connectionSendWindow, start, 'a negative increment must not be applied');
    socket.deliver(encodeJsonFrame(FRAME_TYPE.WINDOW_UPDATE, 0, { increment: 1.5 }));
    assert.equal(mux.connectionSendWindow, start, 'a non-integer increment must not be applied');

    // 2) A valid increment is credited.
    socket.deliver(encodeJsonFrame(FRAME_TYPE.WINDOW_UPDATE, 0, { increment: 512 }));
    assert.equal(mux.connectionSendWindow, start + 512, 'a valid increment must be credited');

    // 3) Sending DATA debits the window by the payload size.
    const stream = mux.createStream();
    assert.ok(stream, 'a stream must be created');
    const before = mux.connectionSendWindow;
    const payload = Buffer.from('hello', 'utf8');
    const streamRef = stream as StreamLike;
    assert.equal(streamRef.sendData(payload, false), true, 'a small payload must be accepted');
    await settle();
    assert.ok(socket.bytesSent() > 0, 'the mux must have sent something');
    assert.equal(
      mux.connectionSendWindow,
      before - payload.length,
      'the window must shrink by exactly the DATA payload'
    );

    // 4) An exhausted window stops the flush; a WINDOW_UPDATE resumes it.
    mux.connectionSendWindow = 0;
    const sentBefore = socket.bytesSent();
    assert.equal(streamRef.sendData(Buffer.from('stalled', 'utf8'), false), true, 'the call is still accepted');
    await settle();
    assert.equal(socket.bytesSent(), sentBefore, 'nothing may go out while the window is exhausted');

    socket.deliver(encodeJsonFrame(FRAME_TYPE.WINDOW_UPDATE, 0, { increment: 4096 }));
    await settle();
    assert.ok(
      socket.bytesSent() > sentBefore,
      'a WINDOW_UPDATE must resume the flush the exhausted window stopped'
    );
  } finally {
    if (typeof mux.destroy === 'function') mux.destroy();
  }
});