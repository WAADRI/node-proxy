// =============================================================================
// Setup scripts must create credential files private (issue #123).
//
// They write config.yaml / config.local.yaml containing the auth token and panel
// credentials, plus a client id file, with no mode - so the files landed with the
// umask default (0644) and any local user on a multi-user host could read them.
//
// The scripts are run by hand (not imported by tests), so this is a source-level
// invariant, like the other tests in this suite.
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

const ROOT = path.join(__dirname, '..', '..');
const files = ['client/scripts/setup.ts', 'server/scripts/setup.ts'];

test('credential files are written with mode 0600', () => {
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const writes = src.split('\n').filter((l) => l.includes('fs.writeFileSync('));
    assert.ok(writes.length > 0, rel + ' must write something');
    for (const line of writes) {
      assert.ok(line.includes('mode: 0o600'), rel + ' must restrict: ' + line.trim());
    }
  }
});
