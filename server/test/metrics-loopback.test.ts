// =============================================================================
// /metrics must not be public (issue #117).
//
// It was listed among the token-free paths, so anyone who could reach the panel
// port could scrape the whole registry: node ids, versions, per-node traffic and
// error counters. A local scraper still works without a token; everything else
// has to authenticate.
//
// AuthManager needs a full config to construct, so this is a source-level
// invariant, like the other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8');

test('/metrics is public only from loopback', () => {
  assert.ok(src.includes("req.path === '/metrics' && fromLoopback"), 'the loopback condition must be present');
  assert.ok(!/^\s*req\.path === '\/metrics' \|\|/m.test(src), 'the unconditional public entry must be gone');
  assert.ok(/const fromLoopback = peer === '127\.0\.0\.1'/.test(src), 'the peer address must be examined');
});
