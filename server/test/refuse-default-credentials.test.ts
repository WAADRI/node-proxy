// =============================================================================
// The server must not run on the shipped credential defaults (issues #118, #121).
//
// config.yaml ships `auth.web.password: admin123` (login required by DEFAULT) and
// `auth.proxy.password: proxy-pass`, both committed to a public repository - so any
// deployment that never changed them is open to anyone who reads the README. This extends
// the token guard from PR #182: same fail-fast, same opt-out flags, and it only complains
// about a feature that is actually enabled (a deployment that turned proxy auth off is not
// nagged about a password it does not use).
//
// server.ts is an entry script, so this is a source-level invariant, like the other tests in
// this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');

test('shipped credential defaults stop startup unless explicitly allowed', () => {
  assert.ok(/auth\.web\.password', 'admin123'/.test(src), 'the panel default must be listed');
  assert.ok(/auth\.proxy\.password', 'proxy-pass'/.test(src), 'the proxy default must be listed');
  assert.ok(/ALLOW_DEFAULT_CREDENTIALS === '1'/.test(src), 'an opt-out must exist');
  assert.ok(/ALLOW_DEFAULT_TOKEN === '1'/.test(src), 'the existing opt-out must keep working too');
  assert.ok(/group\.enabled !== false/.test(src), 'a disabled feature must not be reported');
  assert.ok(/Shipped default credentials are still in use/.test(src), 'and the error must say what is wrong');
  const guard = src.indexOf('auth.web.password');
  const listen = src.indexOf('httpServer.listen(');
  assert.ok(guard > 0 && listen > 0 && guard < listen, 'the guard must run BEFORE the server starts listening');
});