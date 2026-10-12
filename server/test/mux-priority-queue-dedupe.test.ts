// =============================================================================
// The priority queue must not accumulate duplicate ids (issue #119).
//
// There are THREE push sites (createStream, plus two where buffered data or a window update
// re-queues a stream) and exactly one removal path, which deletes a single copy
// (indexOf + splice). So the same stream id could sit in the queue several times: the queue
// grew with entries that were no longer pending, and each removal only cleared one copy. A
// guarded push bounds the queue by the number of streams instead.
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

test('both mux copies push to the priority queue only when absent', () => {
  for (const rel of ['server/lib/stream-mux.ts', 'client/lib/stream-mux.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const name of ['id', 'streamId']) {
      assert.ok(
        src.includes('if (!this._priorityQueue.includes(' + name + ')) this._priorityQueue.push(' + name + ');'),
        rel + ' must dedupe the push for ' + name
      );
    }
    assert.ok(!/^\s*this\._priorityQueue\.push\((id|streamId)\);/m.test(src), rel + ' must not push unguarded');
    assert.ok(/indexOf\(streamId\)/.test(src), rel + ' must still have the removal path');
    assert.ok(/deduplicated on push/.test(src), rel + ' must explain why');
  }
});