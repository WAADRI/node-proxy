// =============================================================================
// Changing the routing strategy must not assume a routing section exists (#122).
//
// config.ts declares `routing` optional and its DEFAULTS have no such section, so
// a server configured purely through environment variables has `config.routing
// === undefined`. SettingsManager applied routing changes through a non-null
// assertion (`this.config.routing!.strategy = ...`), i.e. a TypeError on the first
// panel save: the HTTP handler returned 500 while the in-memory router had already
// switched strategy, so the change half-applied.
//
// The manager needs a config/logger/storage to construct, so the assertions are
// source-level, like the other tests in this suite.
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

const settings = fs.readFileSync(path.join(__dirname, '..', 'lib', 'settings.ts'), 'utf8');
const config = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config.ts'), 'utf8');

test('the routing section is optional in the configuration', () => {
  assert.ok(/routing\?:/.test(config), 'config.ts must keep declaring routing optional');
  assert.ok(!/routing:\s*\{[\s\S]{0,200}strategy/.test(config.split('DEFAULTS')[1] || ''), 'DEFAULTS must not be relied upon for it');
});

test('settings never dereference routing without checking', () => {
  assert.equal(
    (settings.match(/routing!\./g) || []).length,
    0,
    'a non-null assertion here throws for an env-only deployment'
  );
  const builds = settings.match(/this\.config\.routing = \{ \.\.\.\(this\.config\.routing \|\| \{\}\),/g) || [];
  assert.equal(builds.length, 2, `both the apply and the reset path must build the section (found ${builds.length})`);
});
