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

type StreamLike = { id: number; sendData(data: Buffer, endStream: boolean): boolean };
type MuxLike = {
  connectionSendWindow: number;
  connectionRecvWindow: number;
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

test('inbound DATA is credited back to the peer, so the connection window cannot drain', async () => {
  // The regression this covers: the send path debited connectionSendWindow for every DATA batch,
  // but the receive path never debited connectionRecvWindow - so _checkConnectionWindow's
  // "below half" test could never become true, no connection WINDOW_UPDATE was ever sent, and the
  // peer's window drained to zero under load. The flush then stalled on a DATA batch and the
  // heartbeat queued behind it, which is what made a busy node look unhealthy and flap between
  // the breaker's open and half-open states.
  const { StreamMux, FRAME_TYPE } = await loadMux();
  const socket = new FakeSocket();
  const mux = new StreamMux(socket, { connectionWindow: 1024 });

  try {
    const stream = mux.createStream();
    assert.ok(stream, 'a stream must be created');

    // Count connection-level (stream 0) frames of a given type in everything sent so far. The
    // mux batches frames ([2B count][frame]...), so a raw byte-length assertion proves nothing:
    // delivering DATA to a stream the peer has not opened also makes the mux send a control frame
    // (RST_STREAM). Only counting the WINDOW_UPDATE that carries the credit is decisive - with the
    // bug, zero of them are ever sent.
    function connectionFrames(sent: Buffer[], type: number): number {
      let n = 0;
      for (const buf of sent) {
        const count = buf.length >= 2 ? buf.readUInt16BE(0) : 0;
        const frames: Buffer[] = [];
        if (count >= 2) {
          let off = 2;
          while (off + FRAME_HEADER_SIZE <= buf.length && frames.length < count) {
            const len = buf.readUInt32BE(off);
            frames.push(buf.subarray(off, off + FRAME_HEADER_SIZE + len));
            off += FRAME_HEADER_SIZE + len;
          }
        } else if (buf.length >= FRAME_HEADER_SIZE) {
          frames.push(buf);
        }
        for (const f of frames) {
          if (f[4] === type && f.readUInt32BE(5) === 0) n++;
        }
      }
      return n;
    }

    // The threshold is derived from the connection window and the mux also advertises that window
    // at start-up, so take the live value as the baseline. Frames must stay far below the mux's
    // MAX_FRAME_SIZE or the inbound parse drops them (a 1 MiB frame never reached the accounting).
    const full = mux.connectionRecvWindow;
    const frame = Buffer.alloc(512, 0x41);
    const attempts = Math.ceil(full / frame.length) + 5;
    const beforeCredit = connectionFrames(socket.sent, FRAME_TYPE.WINDOW_UPDATE);
    let credited = beforeCredit;
    for (let i = 0; i < attempts && credited === beforeCredit; i++) {
      socket.deliver(encodeFrame(FRAME_TYPE.DATA, stream.id, frame));
      await settle();
      credited = connectionFrames(socket.sent, FRAME_TYPE.WINDOW_UPDATE);
    }
    assert.ok(
      credited > beforeCredit,
      'consuming inbound DATA must eventually send a connection WINDOW_UPDATE, or the peer never learns it can continue'
    );
    // The replenish uses the mux's own constant (see the note in the PR: _checkConnectionWindow
    // compares against DEFAULT_CONNECTION_WINDOW rather than the instance option), so assert the
    // property that matters rather than one exact number.
    assert.ok(
      mux.connectionRecvWindow > full / 2,
      'and the receive window must be restored well above half, not left to drain'
    );

    // Connection-level frames are not data and must not be accounted as such.
    const afterCredit = connectionFrames(socket.sent, FRAME_TYPE.WINDOW_UPDATE);
    const afterCreditWindow = mux.connectionRecvWindow;
    socket.deliver(encodeJsonFrame(FRAME_TYPE.WINDOW_UPDATE, 0, { increment: 16 }));
    await settle();
    assert.equal(
      mux.connectionRecvWindow,
      afterCreditWindow,
      'a control frame must not move the receive window'
    );
    assert.equal(
      connectionFrames(socket.sent, FRAME_TYPE.WINDOW_UPDATE),
      afterCredit,
      'a control frame must not be treated as data and trigger another credit'
    );
  } finally {
    if (typeof mux.destroy === 'function') mux.destroy();
  }
});