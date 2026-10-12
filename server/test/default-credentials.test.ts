// =============================================================================
// The shipped-credential guard, exercised as REAL code (issue #199).
//
// The first version indexed the loaded config with the wrong segment of the path
// 'auth.web.password', so config.auth['auth'] was undefined and the guard never fired for any
// configuration. A source-invariant test stayed green the whole time, which is why this test
// drives the real function with real config objects instead of matching source text.
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

type Config = { auth?: Record<string, { enabled?: boolean; password?: unknown } | undefined> };
type Mod = { findShippedCredentialDefaults: (config: Config | undefined) => string[] };

const mod = require('../lib/default-credentials.ts') as Mod;

test('a deployment still using the shipped panel password is named', () => {
  assert.deepEqual(
    mod.findShippedCredentialDefaults({ auth: { web: { enabled: true, password: 'admin123' } } }),
    ['auth.web.password = admin123'],
    'the shipped panel password must be reported (this is the case the guard missed)'
  );
});

test('the shipped proxy password is named only when proxy auth is enabled', () => {
  assert.deepEqual(
    mod.findShippedCredentialDefaults({ auth: { proxy: { enabled: true, password: 'proxy-pass' } } }),
    ['auth.proxy.password = proxy-pass']
  );
  assert.deepEqual(
    mod.findShippedCredentialDefaults({ auth: { proxy: { enabled: false, password: 'proxy-pass' } } }),
    [],
    'a disabled feature must not be nagged about a password it does not use'
  );
});

test('both shipped defaults are reported together, in a stable order', () => {
  assert.deepEqual(
    mod.findShippedCredentialDefaults({
      auth: { web: { enabled: true, password: 'admin123' }, proxy: { enabled: true, password: 'proxy-pass' } },
    }),
    ['auth.web.password = admin123', 'auth.proxy.password = proxy-pass']
  );
});

test('changed credentials are accepted, and unusual configs do not throw', () => {
  assert.deepEqual(
    mod.findShippedCredentialDefaults({
      auth: { web: { enabled: true, password: 'a-real-password' }, proxy: { enabled: true, password: 'another' } },
    }),
    []
  );
  assert.deepEqual(mod.findShippedCredentialDefaults({}), []);
  assert.deepEqual(mod.findShippedCredentialDefaults(undefined), []);
  assert.deepEqual(mod.findShippedCredentialDefaults({ auth: {} }), []);
  assert.deepEqual(mod.findShippedCredentialDefaults({ auth: { web: {} } }), [], 'no password means no default');
  assert.deepEqual(mod.findShippedCredentialDefaults({ auth: { web: { enabled: true, password: 0 } } }), []);
});

test('server.ts actually consults the detection', () => {
  // Guards against the wiring being dropped while the helper stays correct.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
  assert.ok(/findShippedCredentialDefaults\(config\)/.test(src), 'server.ts must call the detection');
  assert.ok(
    /ALLOW_DEFAULT_CREDENTIALS === '1' \|\| process\.env\.ALLOW_DEFAULT_TOKEN === '1'/.test(src),
    'and keep the documented opt-out'
  );
  assert.ok(
    !/path\.split\('\.'\)/.test(src),
    'the dotted-path parsing that made the guard dead code must not come back'
  );
});