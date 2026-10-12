// =============================================================================
// Secrets must be compared in constant time (issue #117).
//
// Four sites used === on a password or token: user.password (login), config.auth.token
// (web token), and two proxy-auth paths. === short-circuits at the first differing
// byte, which leaks a matching prefix to a timing attacker. safeEqual hashes both
// sides (equal lengths for timingSafeEqual) and compares those.
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

test('every secret comparison goes through safeEqual', () => {
  assert.ok(/import \{ createHash, timingSafeEqual \} from 'crypto';/.test(src), 'crypto must be imported');
  assert.ok(/function safeEqual\(a: string, b: string\): boolean/.test(src), 'the helper must exist');
  assert.ok(/timingSafeEqual\(ha, hb\)/.test(src), 'and must use timingSafeEqual');
  assert.ok(src.includes('safeEqual(user.password, password)'), 'login must use it');
  assert.ok(src.includes('safeEqual(token, this.config.auth.token)'), 'the web token must use it');
  assert.ok(src.includes('safeEqual(password, proxyAuth.password)'), 'proxy auth must use it');
  assert.ok(src.includes('safeEqual(entry.password, password)'), 'the extra-users path must use it');
  assert.ok(!/password === /.test(src), 'no plaintext password comparison may remain');
  assert.ok(!/token === this\.config/.test(src), 'and no plaintext token comparison');
});
