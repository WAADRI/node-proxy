// =============================================================================
// Every panel route in issue #117 must authorise the caller itself (issue #117).
//
// webAuthMiddleware is mounted globally with no required permission, so a route is
// only protected if its handler checks - and 13 handlers never did. The authed-only
// ones are now guarded with the permission code that already exists in ROLES for
// the role that legitimately needs them (viewer holds client:list, client:events,
// proxy:stats, circuit:view, ...), so viewers keep working.
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

const expected: Array<[string, string]> = [
  ["api.get('/status',", 'client:list'],
  ["api.get('/logs',", 'system:logs'],
  ["api.get('/circuit-breaker/status',", 'circuit:view'],
  ["api.get('/bandwidth/stats',", 'proxy:stats'],
  ["api.get('/client/:id/events',", 'client:events'],
  ["api.get('/client/:id/traffic',", 'proxy:stats'],
  ["api.get('/traffic',", 'proxy:stats'],
  ["api.get('/mux/stats',", 'client:list'],
];

test('these routes authorise the caller in their handler', () => {
  for (const [anchor, code] of expected) {
    const i = src.indexOf(anchor);
    assert.ok(i > 0, anchor + ' was not found');
    const body = src.slice(i, i + 600);
    assert.ok(body.includes("hasPermission(str(req.user), '" + code + "')"), anchor + ' must require ' + code);
  }
});
