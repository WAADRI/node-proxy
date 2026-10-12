// =============================================================================
// The server must not run on the shipped default node token (issues #118, #121).
//
// config.yaml ships `token: node-proxy-default-token`, it is committed to a public
// repository, and it is the SHARED secret every node presents - so any deployment that kept
// it is effectively open to anyone who reads this repo. A silently generated replacement is
// not the answer either: every existing node would fail to authenticate at once. So the
// server refuses to start, names the offending value, points at the three ways to set a real
// token, and offers ALLOW_DEFAULT_TOKEN=1 as an explicit opt-out for throwaway setups.
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

test('a shipped default token stops startup unless explicitly allowed', () => {
  assert.ok(/const DEFAULT_TOKENS = \['node-proxy-default-token'/.test(src), 'the known defaults must be listed');
  assert.ok(/DEFAULT_TOKENS\.includes\(configuredToken\)/.test(src), 'the configured token must be checked');
  assert.ok(/process\.env\.ALLOW_DEFAULT_TOKEN !== '1'/.test(src), 'an explicit opt-out must exist');
  assert.ok(/process\.exit\(1\)/.test(src), 'the server must refuse to start');
  assert.ok(/auth\.token is still the shipped default/.test(src), 'and must say which value is wrong');
  assert.ok(/NP_AUTH_TOKEN/.test(src), 'and how to fix it');
  const guard = src.indexOf('const DEFAULT_TOKENS');
  const listen = src.indexOf('httpServer.listen(');
  assert.ok(guard > 0 && listen > 0 && guard < listen, 'the guard must run BEFORE the server starts listening');
});