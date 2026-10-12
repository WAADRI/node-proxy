// =============================================================================
// The panel must never be left without an enabled admin (issue #117).
//
// deleteUser refused to delete the last admin, but counted EVERY admin: with one
// enabled and one disabled admin it happily deleted the enabled one, leaving only a
// disabled account. And modifyUser had no guard at all, so the last admin could be
// demoted or disabled - by themselves or by another admin - locking everyone out of
// user management for good.
//
// AuthManager needs a full config to construct, so this is a source-level invariant,
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8');

test('both mutations preserve an enabled admin', () => {
  const del = src.slice(src.indexOf('deleteUser(username'), src.indexOf('modifyUser(username'));
  assert.ok(/u\.role === 'admin' && u\.enabled/.test(del), 'deleteUser must count enabled admins only');
  const mod = src.slice(src.indexOf('modifyUser(username'), src.indexOf('getRole(username'));
  assert.ok(/enabledAdmins/.test(mod), 'modifyUser must know how many enabled admins exist');
  assert.ok(/if \(wasEnabledAdmin && \(demotes \|\| disables\) && enabledAdmins <= 1\) return false;/.test(mod), 'and must refuse the change');
  assert.ok(mod.indexOf('return false;') < mod.indexOf('if (updates.password)'), 'the refusal must precede any mutation');
  assert.ok(/VALID_ROLES\.includes\(updates\.role as RoleName\)/.test(mod), 'an invalid role must not trigger a refusal');
});
