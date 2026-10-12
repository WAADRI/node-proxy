// =============================================================================
// Cache eviction must be O(1) LRU, not a full scan per insert (issue #122).
//
// _evictOne() walked EVERY entry to find the smallest createdAt, on every insert once
// the cache was full, and ignored `hits` entirely despite a comment claiming it evicted
// the least accessed. Map keeps insertion order, so re-inserting on a hit turns that
// order into access order and makes eviction a single keys().next().
//
// Cache needs a config to construct, so this is a source-level invariant, like the
// other tests in this suite.
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

test('hits refresh the recency order and eviction is O(1)', () => {
  const getBody = src.slice(src.indexOf('get(key: string)'), src.indexOf('set(key: string'));
  assert.ok(/this\.cache\.delete\(key\);/.test(getBody), 'a hit must remove the key');
  assert.ok(/this\.cache\.set\(key, entry\);/.test(getBody), 'and re-insert it (moving it to the end)');
  const evict = src.slice(src.indexOf('private _evictOne()'), src.indexOf('destroy()'));
  assert.ok(/const lru = this\.cache\.keys\(\)\.next\(\);/.test(evict), 'eviction must take the first key');
  assert.ok(!/for \(const \[key, entry\] of this\.cache\)/.test(evict), 'the full scan must be gone');
  assert.ok(!/\/\/ Evict oldest entry or least accessed/.test(evict), 'the misleading comment line must be gone');
});
