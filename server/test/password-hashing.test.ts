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
  // The import FORM decides runtime behaviour: a namespace import of this CJS package leaves
  // bcrypt.hashSync undefined under Node's type stripping, which made every login throw
  // TypeError. This assertion previously pinned the namespace form - it locked the bug in.
  // Anchored to the start of a line so a comment mentioning the old form cannot satisfy it.
  assert.ok(/^import bcrypt from 'bcryptjs';/m.test(src), 'bcryptjs must be imported as a default import');
  assert.ok(
    !/^import \* as bcrypt/m.test(src),
    'a namespace import leaves hashSync undefined at runtime - never restore it'
  );
  assert.ok(/function isBcryptHash\(value: string\): boolean/.test(src), 'the hash detector must exist');
  assert.ok(/bcrypt\.hashSync\(plain, 10\)/.test(src), 'hashing must use bcrypt');
  // Narrow anchor: the statement itself, so wrapping it in a block (the token-epoch change
  // from PR #193 sits on the same statement) does not break this invariant.
  assert.ok(
    /user\.password = hashPassword\(updates\.password\);/.test(src),
    'modifyUser must hash'
  );
  assert.ok(/bcrypt\.compareSync\(password, user\.password\)/.test(src), 'login must accept a hash');
  assert.ok(/user\.password = hashPassword\(password\);/.test(src), 'and upgrade a legacy record in place');
  assert.ok(/bcrypt\.compareSync\(password, entry\.password\)/.test(src), 'config entries must accept a hash too');
  assert.ok(!/\.password = updates\.password;/.test(src), 'no plaintext store may remain');
});
