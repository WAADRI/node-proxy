// =============================================================================
// The daily traffic query must use bound parameters (issue #122).
//
// It built its WHERE clause by interpolation (quote-doubling for the id, a raw number
// for the period) and read the result positionally. The value was not attacker
// controlled - `since` comes from the clamped day count - so this is defence in depth,
// but it was the last string-built query in storage.ts. It now binds the values and
// reads columns by name.
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

test('the daily query binds its filter values', () => {
  const i = src.indexOf('getTrafficDaily(clientId: string');
  assert.ok(i > 0, 'getTrafficDaily was not found');
  const body = src.slice(i, src.indexOf('getTrafficTotal', i) > i ? src.indexOf('getTrafficTotal', i) : i + 2500);
  assert.ok(/const where = clientId \? 'WHERE client_id = \? AND period_start >= \?' : 'WHERE period_start >= \?';/.test(body), 'the clause must be constant');
  assert.ok(/const params: \(string \| number\)\[\] = clientId \? \[clientId, since\] : \[since\];/.test(body), 'values must go in an array');
  assert.ok(/stmt\.bind\(params\)/.test(body), 'and be bound');
  assert.ok(/const row = stmt\.getAsObject\(\);/.test(body), 'rows read by name');
  assert.ok(/stmt\.free\(\);/.test(body), 'statement freed');
  assert.ok(!/\.exec\(/.test(body), 'no exec() call may remain here');
  assert.ok(!/replace\(\/'\/g/.test(body), 'and no quote-doubling');
});
