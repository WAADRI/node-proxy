// =============================================================================
// Prepared statements must be freed even when reading a row throws (issue #122).
//
// Both readers called stmt.free() on the success path only: an exception from
// step()/getAsObject() skipped it entirely, leaking the WASM statement (sql.js)
// and, for the events reader, also skipping the free() that sits after the loop.
//
// Storage needs a database file to construct, so this is a source-level invariant,
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storage.ts'), 'utf8');

test('the events reader frees its statement in a finally block', () => {
  const start = src.indexOf('getClientEvents(clientId: string');
  assert.ok(start > 0, 'getClientEvents was not found');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(/while \(stmt\.step\(\)\)[\s\S]*finally \{\s*stmt\.free\(\);/.test(body), 'the loop must be wrapped so free() always runs');
});

test('the metadata reader frees its statement in a finally block', () => {
  const start = src.indexOf('getClientMetadata(clientId: string');
  assert.ok(start > 0, 'getClientMetadata was not found');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(/try \{\s*const row = stmt\.getAsObject\(\);[\s\S]*finally \{\s*stmt\.free\(\);/.test(body), 'reading the row must be guarded by finally');
});
