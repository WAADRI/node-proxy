// =============================================================================
// The client copy of the mux needs the same outbound backpressure (issue #119).
//
// The server half landed in the previous PR; the two implementations are deliberate copies,
// and a slow peer is just as able to make the CLIENT hold an arbitrarily large pending buffer
// (every frame goes into the ws library own buffer and nothing read bufferedAmount). The fix
// is identical: defer the flush above the high-water mark, resume on a timer, and bound the
// deferrals so a permanently slow peer degrades to the old behaviour instead of stalling.
//
// This test iterates BOTH copies on purpose: the invariant is that they stay the same shape,
// so changing only one of them fails here.
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

test('both mux copies apply the same bounded outbound backpressure', () => {
  for (const rel of ['server/lib/stream-mux.ts', 'client/lib/stream-mux.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/const OUTBOUND_HIGH_WATER = 4 \* 1024 \* 1024;/.test(src), rel + ' must define the high-water mark');
    assert.ok(/const MAX_DEFERRALS = 100;/.test(src), rel + ' must bound the deferrals');
    assert.ok(/private _deferrals = 0;/.test(src), rel + ' must track the budget per instance');
    assert.ok(
      /if \(buffered > OUTBOUND_HIGH_WATER && this\._deferrals < MAX_DEFERRALS\)/.test(src),
      rel + ' must check both before deferring'
    );
    assert.ok(/this\._sendBuffer\.unshift\(\.\.\.batch\);/.test(src), rel + ' must put the batch back');
    assert.ok(/this\._deferrals = 0; \/\/ a pass that actually sends resets the budget/.test(src), rel + ' must reset on a real send');
    const guard = src.indexOf('buffered > OUTBOUND_HIGH_WATER');
    const send = src.indexOf('this.ws.send(sendData');
    assert.ok(guard > 0 && send > 0 && guard < send, rel + ' must check before sending');
  }
});