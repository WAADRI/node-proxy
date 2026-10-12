// =============================================================================
// The traffic stats aggregate must use bound parameters (issue #122).
//
// getTrafficStats used db.exec() with quote-doubling for the client id and a RAW
// numeric interpolation for `since`. exec() cannot bind, so prepare()+bind() is the
// only way to remove both at once - and the SQL already aliases its columns (bs/br/rc),
// so the result is read by name rather than by position.
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

test('the traffic aggregate binds clientId and since', () => {
  const i = src.indexOf('getTrafficStats(clientId: string');
  assert.ok(i > 0, 'getTrafficStats was not found');
  const body = src.slice(i, src.indexOf('getTrafficDaily(', i));
  assert.ok(body.includes('WHERE client_id = ? AND period_start >= ?'), 'the SQL must be parameterised');
  assert.ok(/stmt\.bind\(\[clientId, since \|\| 0\]\)/.test(body), 'both values must be bound');
  assert.ok(/const row = stmt\.getAsObject\(\);/.test(body), 'the row must be read by name');
  assert.ok(/stmt\.free\(\);/.test(body), 'and the statement freed');
  assert.ok(!/\.exec\(/.test(body), 'no exec() call may remain here');
  assert.ok(!/replace\(\/'\/g/.test(body), 'and no quote-doubling');
});
