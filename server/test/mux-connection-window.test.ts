// =============================================================================
// Connection-level flow control must actually flow (issue #119 / PR #189).
//
// Two halves are needed, and the first is useless without the second:
//   1) the connection send window must be DEBITED by the DATA payload actually sent. It was
//      credited by WINDOW_UPDATE and never debited, so the exhausted-window check in the batch
//      path could never trip and the window was decorative;
//   2) when a WINDOW_UPDATE arrives, a flush that the window stopped must be RESUMED. The batch
//      path puts the frames back and clears _sending, and only a NEW outbound frame would
//      otherwise reschedule it - so a quiet stream could wait indefinitely.
// The header length is a single named constant so this accounting cannot drift from _sendFrame.
//
// StreamMux needs a socket-like object to construct, so this pins the two properties above.
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

const ROOT = path.join(__dirname, '..', '..');

test('both mux copies debit the connection window and resume after an update', () => {
  for (const rel of ['server/lib/stream-mux.ts', 'client/lib/stream-mux.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/const FRAME_HEADER_SIZE = 13;/.test(src), rel + ' must name the frame header length');
    assert.ok(/Buffer\.alloc\(FRAME_HEADER_SIZE\)/.test(src), rel + ' must use it when encoding');
    assert.ok(/this\.connectionSendWindow -= dataBytes;/.test(src), rel + ' must debit the window when sending');
    assert.ok(/f\[4\] === FRAME_TYPE\.DATA \? sum \+ \(f\.length - FRAME_HEADER_SIZE\)/.test(src), rel + ' must count DATA payload only');
    assert.ok(/connectionSendWindow \+=/.test(src), rel + ' must still credit WINDOW_UPDATE');
    assert.ok(
      /if \(!this\._sending && this\._sendBuffer\.length > 0\) \{/.test(src),
      rel + ' must resume the flush when the window grows again'
    );
    assert.ok(/setImmediate\(\(\) => this\._flushSendBuffer\(\)\);/.test(src), rel + ' and actually schedule it');
    const debit = src.indexOf('this.connectionSendWindow -= dataBytes;');
    const send = src.indexOf('this.ws.send(sendData');
    assert.ok(debit > 0 && send > 0 && debit < send, rel + ' must debit BEFORE the frames go out');
  }
});