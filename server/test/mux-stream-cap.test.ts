// =============================================================================
// A peer must not be able to open streams without limit (issue #119).
//
// createStream() registered every stream in this.streams and pushed its id onto
// _priorityQueue, and the map is only pruned when a stream ENDS - so a peer that simply
// keeps opening streams grows both structures until the process dies. The cap lives in
// both copies of the mux (server and client) because either side can be the opener.
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

test('both mux copies cap the number of open streams', () => {
  for (const rel of ['server/lib/stream-mux.ts', 'client/lib/stream-mux.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/const MAX_CONCURRENT_STREAMS = 512;/.test(src), rel + ' must define the cap');
    const cap = src.indexOf('this.streams.size >= MAX_CONCURRENT_STREAMS');
    const set = src.indexOf('this.streams.set(id, stream);');
    assert.ok(cap > 0, rel + ' must check the cap');
    assert.ok(set > 0, rel + ' must still register streams');
    assert.ok(cap < set, rel + ' must check the cap BEFORE registering');
    assert.ok(/Refusing stream: too many open streams/.test(src), rel + ' must report the refusal');
  }
});