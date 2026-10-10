// =============================================================================
// The node must survive malformed mux frames from its peer (issue #113 / #118).
//
// The client parser had the same holes as the server's: the single-frame path
// read the header unconditionally (a 2..12 byte binary frame threw
// ERR_OUT_OF_RANGE out of the 'message' listener), a declared length was never
// compared with the bytes actually received, and _handleConnectionFrame parsed
// its payload as JSON without a try/catch. On the node these are not fatal - the
// process-level handler only logs and reconnects - but they abort handling and
// flood the log, and a MITM of a plain ws:// control connection can send them.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { StreamMux } = require('../lib/stream-mux.ts');

// A StreamMux owns timers; destroy them or the test process never exits.
const created: Array<{ destroy(): void }> = [];
test.after(() => {
  for (const m of created) m.destroy();
});

function makeMux() {
  const ws = new EventEmitter();
  const logs: string[] = [];
  const logger = {
    debug: (obj: object, msg?: string) => logs.push(String(msg ?? '')),
    error: () => {},
  };
  const mux = new StreamMux(ws, { logger, initialWindow: 65536, connectionWindow: 1048576 });
  mux.onStream(() => {});
  created.push(mux);
  return { ws, mux, logs };
}

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
  const { ws, logs } = makeMux();
  for (const len of [2, 3, 5, 9, 12]) {
    assert.doesNotThrow(() => ws.emit('message', Buffer.alloc(len, 0), true), `a ${len}-byte frame`);
  }
  assert.ok(logs.length >= 5, `every dropped frame must be reported, got ${logs.length}`);
});

test('a frame that declares more than it carries is dropped', () => {
  const { ws } = makeMux();
  const oversized = Buffer.alloc(13);
  oversized.writeUInt32BE(20000, 0); // above the 16 KiB frame limit
  assert.doesNotThrow(() => ws.emit('message', oversized, true), 'an over-limit declared length');
  const short = Buffer.alloc(15);
  short.writeUInt32BE(10, 0); // claims 10 payload bytes, carries 2
  assert.doesNotThrow(() => ws.emit('message', short, true), 'a truncated payload');
});

test('a connection frame with a non-JSON payload is dropped', () => {
  const { ws, logs } = makeMux();
  const ping = Buffer.alloc(13);
  ping.writeUInt32BE(0, 0);
  ping[4] = 0x07; // PING
  ping.writeUInt32BE(0, 5); // stream id 0 -> connection frame
  assert.doesNotThrow(() => ws.emit('message', ping, true), 'an empty connection-frame payload');
  assert.ok(logs.some((l) => l.includes('invalid payload')), 'the invalid payload must be reported');
});

test('well-formed frames are still accepted', () => {
  const { ws, logs } = makeMux();
  assert.doesNotThrow(() => ws.emit('message', frame(Buffer.from('hello')), true));
  const batch = Buffer.concat([
    Buffer.from([0x00, 0x02]),
    frame(Buffer.from('a'), 0x00, 1),
    frame(Buffer.from('b'), 0x00, 2),
  ]);
  assert.doesNotThrow(() => ws.emit('message', batch, true));
  assert.deepEqual(
    logs.filter((l) => l.includes('malformed') || l.includes('truncated')),
    [],
    'valid traffic must not be reported as malformed'
  );
});
