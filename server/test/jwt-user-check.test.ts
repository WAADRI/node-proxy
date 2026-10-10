// =============================================================================
// A valid token is not enough: the account must still exist and be enabled (#117).
//
// verifyWebToken only checks the signature and exp (24h), and the middleware copied
// username/role straight out of the payload - so disabling or deleting a user left
// their tokens working until they expired. The middleware now consults this.users,
// the same way hasPermission does.
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

test('the web middleware re-checks the user on every request', () => {
  const start = src.indexOf('webAuthMiddleware(requiredPermission');
  assert.ok(start > 0, 'webAuthMiddleware was not found');
  const body = src.slice(start, start + 2600);
  assert.ok(/const liveUsername = result\.username;/.test(body), 'the optional username must be narrowed');
  assert.ok(/this\.users\.get\(liveUsername\)/.test(body), 'the live user must be looked up');
  assert.ok(/if \(!liveUser \|\| !liveUser\.enabled\)/.test(body), 'a missing or disabled account must be refused');
  // Compare absolute positions: the guard pushed the assignment beyond the slice above.
  assert.ok(
    src.indexOf('liveUser.enabled') < src.indexOf('req.user = result.username'),
    'the check must run BEFORE the request is authenticated as that user'
  );
  assert.ok(body.includes("message: 'Account is disabled or no longer exists'"), 'and the API must say so');
});
