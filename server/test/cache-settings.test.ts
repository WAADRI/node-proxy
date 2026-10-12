// =============================================================================
// The cache settings group must never disable cache expiry (issue #122).
//
// POST /api/v1/settings/cache with an empty body slipped past _numFields (it only
// errors when it was given fields to parse), so `config.cache.default_ttl` and the
// live limiter were set to undefined - and every entry then compared its age
// against undefined, i.e. never expired. reset(cache) had the same hole when the
// base configuration had no cache section at all.
//
// SettingsManager needs config/logger/storage to construct, so these are
// source-level invariants, like the other tests in this suite.
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

const settings = fs.readFileSync(path.join(__dirname, '..', 'lib', 'settings.ts'), 'utf8');
const cache = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cache.ts'), 'utf8');

test('the cache group refuses a body without default_ttl', () => {
  assert.ok(
    settings.includes("if (num.values!.default_ttl === undefined) return { ok: false, error: 'default_ttl is required' }"),
    'an empty body must be rejected instead of writing undefined'
  );
  assert.ok(settings.includes('?? 5000'), 'reset must fall back to the documented default');
});

test('the limiter itself cannot end up with a non-positive TTL', () => {
  assert.ok(
    /Number\.isFinite\(configuredTTL\) && configuredTTL > 0 \? configuredTTL : 5000/.test(cache),
    'a defensive fallback must exist in the constructor'
  );
});
