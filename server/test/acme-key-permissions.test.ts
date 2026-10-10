// =============================================================================
// An ACME private key must not be world-readable (issue #122).
//
// The issuance path wrote `<domain>-key.pem` with fs.writeFileSync and no mode, so
// it inherited the umask default (0644 on a typical server) - the TLS private key
// of every domain readable by any local user. mode only takes effect on creation,
// hence the chmod as well.
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

test('the private key is written and repaired with mode 0600', () => {
  assert.ok(/mode: 0o600/.test(src), 'the key must be created with 0600');
  assert.ok(/fs\.chmodSync\(keyPath, 0o600\)/.test(src), 'and an existing key must be tightened');
  assert.ok(/fs\.writeFileSync\(keyPath, toStringable\(key\)\.toString\(\), \{ mode: 0o600 \}\)/.test(src), 'the only key write must carry the mode');
});
