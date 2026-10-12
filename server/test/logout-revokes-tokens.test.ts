// =============================================================================
// Logout must revoke the caller's tokens AND still clear the cookie (issue #118).
//
// Clearing a cookie cannot cancel a stateless JWT, so logout advances the user's epoch too. The
// route is registered BEFORE the auth middleware, so it cannot rely on req.user: it reads the
// token the same way the middleware does (Bearer header, then cookie) and revokes the username
// that token resolves to. An unauthenticated logout stays a no-op success.
//
// Both halves are asserted together because they came from two PRs (#165 cleared the cookie,
// #194 revoked the token) that conflict on this exact route - a merge that keeps only one of
// them is the failure this test is meant to prevent.
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

const ROOT = path.join(__dirname, '..');

test('logout revokes the tokens of the caller and clears the cookie', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'lib', 'auth.ts'), 'utf8');
  assert.ok(/revokeUserTokens\(username: string\): boolean \{/.test(auth), 'a revocation entry point must exist');
  assert.ok(/user\.tokenVersion = \(user\.tokenVersion \|\| 0\) \+ 1;/.test(auth), 'it must advance the epoch');
  const web = fs.readFileSync(path.join(ROOT, 'lib', 'web-server.ts'), 'utf8');
  const start = web.indexOf("app.post('/api/logout'");
  assert.ok(start > 0, 'the logout route was not found');
  const body = web.slice(start, web.indexOf('});', start) + 3);
  assert.ok(/authHeader\.startsWith\('Bearer '\)/.test(body), 'it must read the Bearer header');
  assert.ok(/req\.cookies && req\.cookies\.token/.test(body), 'and fall back to the cookie');
  assert.ok(/authManager\.verifyWebToken\(logoutToken\)/.test(body), 'it must resolve the caller from the token');
  assert.ok(/authManager\.revokeUserTokens\(result\.username\)/.test(body), 'and revoke that user');
  assert.ok(/res\.clearCookie\('token'\)/.test(body), 'and still clear the cookie (PR #165 half)');
  assert.ok(/res\.json\(\{ success: true \}\)/.test(body), 'an unauthenticated logout must still succeed');
});