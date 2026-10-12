// =============================================================================
// ACME must not silently issue staging certificates (issue #122).
//
// `const staging = acmeConfig.staging !== false` made staging the DEFAULT: enabling
// ACME without setting the flag produced certificates from the staging directory,
// which no browser trusts, and only a single info line hinted at it. Production is
// the sane default for a setting whose whole purpose is a trusted certificate.
//
// AcmeManager needs config/logger to construct, so this is a source-level
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acme.ts'), 'utf8');

test('staging is opt-in, not the default', () => {
  assert.ok(src.includes('const staging = acmeConfig.staging === true;'), 'staging must require an explicit true');
  assert.ok(!src.includes('acmeConfig.staging !== false'), 'the old inverted default must be gone');
  assert.ok(/this\.log\.info\(\{ domains: this\.domains, staging \}/.test(src), 'the choice must still be logged');
});
