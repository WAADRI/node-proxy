// =============================================================================
// The proxy must bound the request body it buffers (issue #119).
//
// This path accumulates the whole body (then base64s it, so ~1.33x again) before forwarding,
// and nothing limited the total: one client could make the process hold an arbitrarily large
// upload and exhaust it. A 64 MiB cap now applies; exceeding it answers 413, releases what was
// buffered and destroys the request. The cap is also the largest body this proxy will forward,
// which is the deliberate trade - previously that limit simply did not exist.
//
// The server needs a config to start, so this is a source-level invariant, like the other
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy-http.ts'), 'utf8');

test('the buffered request body is bounded', () => {
  assert.ok(/const MAX_PROXY_BODY_BYTES = 64 \* 1024 \* 1024;/.test(src), 'a limit must exist');
  assert.ok(/bodyBytes \+= chunk\.length;/.test(src), 'the accumulated size must be tracked');
  assert.ok(/if \(bodyBytes > MAX_PROXY_BODY_BYTES\)/.test(src), 'and compared against the limit');
  assert.ok(/res\.writeHead\(413/.test(src), 'an oversized body must answer 413');
  assert.ok(/chunks\.length = 0;/.test(src), 'and release what was buffered');
  assert.ok(/req\.destroy\(\);/.test(src), 'and stop the request');
  const limit = src.indexOf('bodyBytes > MAX_PROXY_BODY_BYTES');
  const push = src.indexOf('chunks.push(chunk);');
  assert.ok(limit > 0 && push > 0 && limit < push, 'the check must run BEFORE the chunk is kept');
});