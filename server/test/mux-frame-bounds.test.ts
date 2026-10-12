// =============================================================================
// Malformed StreamMux frames must be dropped, never fatal.
//
// A binary frame is parsed as soon as the socket opens, BEFORE authentication
// (ws-server wires the mux on connection and checks auth later). The single-frame
// path used to read the header unconditionally, so a 2-byte frame threw
// ERR_OUT_OF_RANGE from the 'message' listener, and server.ts treats any
// non-transient uncaught exception as fatal:
//
//     logger.fatal(...); process.exit(1);
//
// i.e. one two-byte binary frame from an unauthenticated peer killed the server.
// These checks drive the real parser through a fake socket and assert it neither
// throws nor rejects well-formed frames.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { StreamMux, MAX_FRAME_SIZE } = require('../lib/stream-mux.ts');

// A StreamMux owns timers (connection window, ping); destroy them or the test
// process never exits.
const created: Array<{ destroy(): void }> = [];
test.after(() => {
  for (const m of created) m.destroy();
});

function makeMux() {
  const ws = new EventEmitter();
  const warnings: string[] = [];
  const noop = () => {};
  const logger = {
    info: noop,
    warn: (a: unknown, b?: unknown) => warnings.push(String(b ?? a)),
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  };
  const mux = new StreamMux(ws, { logger, initialWindow: 65536, connectionWindow: 1048576 });
  mux.onStream(() => {});
  created.push(mux);
  return { ws, mux, warnings };
}

// A well-formed single frame: [len][type][stream][flags][payload]
function frame(payload: Buffer, type = 0x00, streamId = 1): Buffer {
  const buf = Buffer.alloc(13 + payload.length);
  buf.writeUInt32BE(payload.length, 0);
  buf[4] = type;
  buf.writeUInt32BE(streamId, 5);
  buf.writeUInt32BE(0, 9);
  payload.copy(buf, 13);
  return buf;
}

test('truncated binary frames cannot throw', () => {
  const { ws, warnings } = makeMux();
  // Anything shorter than the 13-byte header used to read out of bounds.
  for (const len of [2, 3, 5, 9, 12]) {
    assert.doesNotThrow(() => ws.emit('message', Buffer.alloc(len, 0), true), `a ${len}-byte frame`);
  }
  assert.ok(warnings.length >= 5, `every dropped frame must be reported, got ${warnings.length}`);
});

test('a frame that declares more than it carries is dropped', () => {
  const { ws } = makeMux();
  const oversized = Buffer.alloc(13);
  oversized.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);
  assert.doesNotThrow(() => ws.emit('message', oversized, true), 'a length above MAX_FRAME_SIZE');

  const short = Buffer.alloc(13 + 2);
  short.writeUInt32BE(10, 0); // claims 10 payload bytes, carries 2
  assert.doesNotThrow(() => ws.emit('message', short, true), 'a truncated payload');
});

test('a malformed batch frame is dropped', () => {
  const { ws } = makeMux();
  // count = 2, then one truncated frame: the batch decoder must stop at the bound.
  const batched = Buffer.concat([Buffer.from([0x00, 0x02]), Buffer.alloc(6, 0)]);
  assert.doesNotThrow(() => ws.emit('message', batched, true));
});

test('a connection frame with a non-JSON payload is dropped', () => {
  const { ws, warnings } = makeMux();
  // streamId 0 routes to _handleConnectionFrame, whose payload is parsed as JSON:
  // an empty payload (13 header bytes, type PING) used to throw SyntaxError out
  // of the 'message' listener, i.e. exit the process.
  const ping = Buffer.alloc(13);
  ping.writeUInt32BE(0, 0); // declared payload length 0
  ping[4] = 0x07; // FRAME_TYPE.PING
  ping.writeUInt32BE(0, 5); // stream id 0 -> connection frame
  assert.doesNotThrow(() => ws.emit('message', ping, true), 'an empty connection-frame payload');
  assert.ok(
    warnings.some((w) => w.includes('invalid payload')),
    'the invalid payload must be reported'
  );
});

test('well-formed frames are still accepted', () => {
  const { ws, warnings } = makeMux();
  assert.doesNotThrow(() => ws.emit('message', frame(Buffer.from('hello')), true));
  // A batch of two valid frames.
  const batch = Buffer.concat([
    Buffer.from([0x00, 0x02]),
    frame(Buffer.from('a'), 0x00, 1),
    frame(Buffer.from('b'), 0x00, 2),
  ]);
  assert.doesNotThrow(() => ws.emit('message', batch, true));

  const complaints = warnings.filter((w) => w.includes('malformed') || w.includes('truncated'));
  assert.deepEqual(complaints, [], 'valid traffic must not be reported as malformed');
});
