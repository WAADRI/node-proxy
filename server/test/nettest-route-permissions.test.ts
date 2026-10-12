// =============================================================================
// The network-test routes must authorise the caller (issue #117).
//
// These three were among the routes with no handler-level check. Their correct code
// is nettest:run, which PR #127 introduced - which is why this branch is STACKED on
// it: referencing the code from a main-based branch would have denied EVERYONE (the
// same class of mistake #115 review caught).
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

test('network-test routes require nettest:run', () => {
  for (const anchor of ["api.get('/network-test/types',", "api.post('/network-test',", "api.get('/network-test/:id',"]) {
    const i = src.indexOf(anchor);
    assert.ok(i > 0, anchor + ' was not found');
    assert.ok(src.slice(i, i + 600).includes("hasPermission(str(req.user), 'nettest:run')"), anchor + ' must require nettest:run');
  }
  assert.ok(/nettest:run/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8')), 'the permission code must exist in ROLES');
});
