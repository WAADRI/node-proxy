// =============================================================================
// Panel passwords must be stored hashed, without an offline migration (#117).
//
// They were plaintext (user.password = updates.password) and login compared them with
// ===. bcryptjs was already a dependency but unused. This change hashes on store,
// accepts BOTH forms on verify (a bcrypt hash is recognisable by its $2a/$2b/$2y
// prefix) and upgrades a legacy plaintext record in place on the first successful
// login - so config-seeded users keep working and nothing must be migrated ahead of
// time.
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

test('passwords are hashed on store and both forms verify', () => {
  assert.ok(/import \* as bcrypt from 'bcryptjs';/.test(src), 'bcryptjs must be imported');
  assert.ok(/function isBcryptHash\(value: string\): boolean/.test(src), 'the hash detector must exist');
  assert.ok(/bcrypt\.hashSync\(plain, 10\)/.test(src), 'hashing must use bcrypt');
  assert.ok(/if \(updates\.password\) user\.password = hashPassword\(updates\.password\);/.test(src), 'modifyUser must hash');
  assert.ok(/bcrypt\.compareSync\(password, user\.password\)/.test(src), 'login must accept a hash');
  assert.ok(/user\.password = hashPassword\(password\);/.test(src), 'and upgrade a legacy record in place');
  assert.ok(/bcrypt\.compareSync\(password, entry\.password\)/.test(src), 'config entries must accept a hash too');
  assert.ok(!/\.password = updates\.password;/.test(src), 'no plaintext store may remain');
});
