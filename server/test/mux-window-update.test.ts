// =============================================================================
// A WINDOW_UPDATE increment must be validated (issue #119).
//
// Both sides did `sendWindow += p.increment || 0` (and the same for the connection
// window), so a NEGATIVE increment drove the window to a huge negative number: the
// sender's own flow control then stalls forever, and one peer can freeze a connection for
// free. Zero is equally meaningless, and a sane upper bound rules out overflow tricks. An
// invalid update is now IGNORED instead of applied - the stream-level site stays silent
// (it lives on Stream, which has no logger) and the connection-level one logs it.
//
// StreamMux needs a socket-like object to construct, so this is a source-level invariant,
// like the other tests in this suite.
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

test('both mux copies validate the window increment', () => {
  for (const rel of ['server/lib/stream-mux.ts', 'client/lib/stream-mux.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/export const MAX_WINDOW_INCREMENT = 16 \* 1024 \* 1024;/.test(src), rel + ' must define the bound');
    assert.ok(!/\+= p\.increment \|\| 0;/.test(src), rel + ' must not apply a raw increment');
    assert.ok(src.includes('Number.isInteger(sendWindowInc) && sendWindowInc > 0'), rel + ' must validate the stream window');
    assert.ok(src.includes('Number.isInteger(connectionSendWindowInc) && connectionSendWindowInc > 0'), rel + ' must validate the connection window');
    assert.ok(src.includes('this.sendWindow += sendWindowInc;'), rel + ' must apply only a validated stream increment');
    assert.ok(src.includes('this.connectionSendWindow += connectionSendWindowInc;'), rel + ' must apply only a validated connection increment');
    assert.ok(/Ignoring invalid WINDOW_UPDATE increment/.test(src), rel + ' must report it at the connection level');
  }
});