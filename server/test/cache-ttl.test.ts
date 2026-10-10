// =============================================================================
// The cache must not serve an entry past its TTL (issue #122).
//
// get() returned whatever was in the map and only bumped the hit counter; expiry
// happened exclusively in the 30s cleanup timer, so an entry with a 5s TTL stayed
// readable for up to ~35s - roughly seven times its lifetime.
//
// RequestCache needs a config/logger to construct and its set() takes a response
// shape, so this pins the invariant at the source level, like the other tests here.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cache.ts'), 'utf8');

test('get() expires entries instead of waiting for the cleanup timer', () => {
  const start = src.indexOf('  get(key: string): CacheHit | null {');
  assert.ok(start > 0, 'get() was not found');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(/createdAt/.test(body), 'get() must compare the entry age');
  assert.ok(/this\.cache\.delete\(key\)/.test(body), 'an expired entry must be dropped, not served');
  assert.ok(body.indexOf('createdAt') < body.indexOf('hits++'), 'expiry must be checked before the hit is counted');
});

test('the default TTL still falls back to a positive number', () => {
  assert.ok(/this\.defaultTTL = config\.cache\?\.default_ttl \|\| 5000/.test(src), 'a missing or zero default_ttl must not disable expiry');
});
