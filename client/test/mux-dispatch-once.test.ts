// =============================================================================
// A mux request must be dispatched exactly once (issue #125 review).
//
// The response path calls stream.close() to release the stream, and Stream.close()
// invokes _onEnd again when the state is half_closed_local. In the node that same
// _onEnd is the request dispatcher, so closing a finished request re-ran it - each
// mux request produced TWO outbound requests.
//
// client.ts is an entry script, so this is a source-level invariant, like the other
// tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'client.ts'), 'utf8');

test('handleMuxRequest dispatches through a once-only guard', () => {
  const start = src.indexOf('function handleMuxRequest');
  assert.ok(start > 0, 'handleMuxRequest was not found');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/let dispatched = false;/.test(body), 'a dispatch flag must exist');
  assert.ok(/if \(dispatched\) return;/.test(body), 'and must short-circuit repeats');
  assert.ok(/dispatchOnce\(Buffer\.concat\(bodyChunks\)/.test(body), '_onEnd must go through it');
  assert.ok(/dispatchOnce\(''\)/.test(body), 'the no-body path must go through it too');
  assert.ok(!/stream\._onEnd = \(\) => \{\s*const body = Buffer\.concat/.test(src), 'the raw dispatch must be gone');
  assert.ok(
    !/if \(stream\.state === 'half_closed_remote' \|\| stream\.state === 'closed'\) \{\s*executeMuxRequest/.test(src),
    'the raw no-body dispatch must be gone'
  );
});
