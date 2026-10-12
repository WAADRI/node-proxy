// =============================================================================
// The login route must be rate limited (issue #117).
//
// /api/login is registered before the auth middleware, so it is public and had no
// failure limit at all: a password could be brute-forced at full request rate. It now
// counts failures per peer+username, locks for 15 minutes after 5 inside a 15 minute
// window, clears the record on success, and bounds the map so a flood of random
// usernames cannot grow it without limit.
//
// web-server.ts needs a full config to start, so this is a source-level invariant,
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'web-server.ts'), 'utf8');

test('login failures are counted, locked and bounded', () => {
  assert.ok(/const LOGIN_MAX_FAILURES = 5;/.test(src), 'a failure threshold must exist');
  assert.ok(/const loginFailures = new Map<string, \{ count: number; first: number; until: number \}>\(\);/.test(src), 'the failure map must be typed');
  assert.ok(/res\.status\(429\)\.json\(\{ success: false, message: 'Too many failed attempts/.test(src), 'a locked key must be refused with 429');
  assert.ok(/loginFailures\.delete\(loginKey\);/.test(src), 'success must clear the record');
  assert.ok(/until: failures >= LOGIN_MAX_FAILURES \? now \+ LOGIN_LOCK_MS : 0,/.test(src), 'reaching the threshold must set a lock');
  assert.ok(/while \(loginFailures\.size > 1000\)/.test(src), 'the map must be bounded');
});
