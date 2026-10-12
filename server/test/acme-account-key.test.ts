// =============================================================================
// The ACME account key must be persisted and reused (issue #122).
//
// `accountKey: await acme.forge.createPrivateKey()` minted a FRESH key on every issuance,
// i.e. a new ACME account each time: that burns the CA's new-account/new-order rate limits
// and makes the account meaningless. The key is now read from (or written to) cert_dir
// with mode 0600 - the same treatment the certificate private key got - and a read-only
// key store degrades to "not reused" rather than breaking issuance.
//
// AcmeManager needs config/logger to construct, so this is a source-level invariant, like
// the other tests in this suite.
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

test('the account key is loaded from disk, created once, and stored 0600', () => {
  assert.ok(!/accountKey: await acme\.forge\.createPrivateKey\(\)/.test(src), 'the key must not be minted per issuance');
  assert.ok(src.includes('accountKey: await this._accountKey(acme),'), 'the client must use the persisted account key');
  assert.ok(/_accountKey\(acme: AcmeLibrary\): Promise<string>/.test(src), 'the helper must be typed');
  assert.ok(src.includes("path.join(this.certDir, 'acme-account-key.pem')"), 'the key lives beside the certificates');
  assert.ok(/fs\.writeFileSync\(file, created, \{ mode: 0o600 \}\)/.test(src), 'it must be created 0600');
  assert.ok(/fs\.chmodSync\(file, 0o600\)/.test(src), 'and repaired if it already existed');
  assert.ok(/readFileSync\(file, 'utf8'\)/.test(src), 'an existing key must be reused');
});