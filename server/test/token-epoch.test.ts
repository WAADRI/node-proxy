// =============================================================================
// Issued tokens must be revocable without a session store (issue #118).
//
// verifyWebToken only checked the signature and exp (24h), so a password change - or a deleted
// account - left every previously issued token working. Tokens now carry the user's epoch
// (ver) and verification compares it with the live user, so bumping the epoch invalidates
// them at once:
//   * a password change bumps it in modifyUser;
//   * a missing user is treated as revoked (expected -1 cannot match any issued value).
//
// Logout-side revocation is NOT here: /api/logout is registered before the auth middleware, so
// the handler does not know which user is logging out. Covering it needs either moving the
// route behind the middleware (which would break unauthenticated logout) or reading the token
// in the handler - a separate, deliberate change.
//
// AuthManager needs a full config to construct, so this is a source-level invariant, like the
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8');

test('tokens carry an epoch that verification checks', () => {
  assert.ok(/tokenVersion\?: number;/.test(src), 'the user record must have an epoch');
  assert.ok(/ver: user\?\.tokenVersion \|\| 0,/.test(src), 'issued tokens must carry it');
  assert.ok(/const issued = typeof payload\.ver === 'number' \? payload\.ver : 0;/.test(src), 'verification must read it');
  assert.ok(/if \(!live \|\| issued !== expected\) return \{ valid: false, error: 'token revoked' \};/.test(src), 'a mismatch must be refused');
  assert.ok(/user\.tokenVersion = \(user\.tokenVersion \|\| 0\) \+ 1;/.test(src), 'a password change must bump it');
  const bump = src.indexOf('user.tokenVersion = (user.tokenVersion || 0) + 1;');
  const assign = src.indexOf('user.password = hashPassword(updates.password);');
  assert.ok(bump > assign && assign > 0, 'the bump must happen together with the password assignment (now the hashed form)');
});
