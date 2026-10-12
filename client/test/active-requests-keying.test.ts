// =============================================================================
// A peer-supplied request id must not overwrite an in-flight entry (issue #123).
//
// activeRequests is keyed by the id the peer sends. A duplicate id (a buggy or
// hostile node) overwrote the existing entry, so the first request's response could
// never be matched and the cleanup handlers - which delete by id - dropped the wrong
// req. Both the mux and the JSON path now refuse a duplicate and drop it.
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

test('both request paths refuse a duplicate id', () => {
  for (const name of ['requestId', 'id']) {
    const re = new RegExp('if \\(activeRequests\\.has\\(' + name + '\\)\\) \\{');
    assert.ok(re.test(src), name + ' must be checked before it is stored');
  }
  assert.ok(/Duplicate request id/.test(src), 'and the duplicate must be reported');
  assert.ok(
    src.indexOf('activeRequests.has(requestId)') < src.indexOf('activeRequests.set(requestId, { req })'),
    'the check must precede the store for requestId'
  );
  assert.ok(
    src.indexOf('activeRequests.has(id)') < src.indexOf('activeRequests.set(id, { req })'),
    'the check must precede the store for id'
  );
});
