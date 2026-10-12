// =============================================================================
// The ACME domain must be validated before it reaches a file path (issue #122).
//
// It is interpolated into cert_dir/<domain>.pem and <domain>-key.pem, so a value like
// "../../etc/x" would read and write outside the certificate directory. It comes from
// configuration rather than the network, which is why this is hardening rather than a
// live vulnerability - but a path built from a value should be validated, and the write
// path is the one that can overwrite files.
//
// AcmeManager needs config/logger to construct, so this is a source-level invariant,
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acme.ts'), 'utf8');

// True when a guard call appears somewhere before the given snippet.
function guardBefore(needle: string): boolean {
  const at = src.indexOf(needle);
  if (at < 0) return false;
  return src.lastIndexOf('assertSafeDomain(domain);', at) > 0;
}

test('every statement that builds a path from the domain is guarded', () => {
  assert.ok(/^function assertSafeDomain\(domain: string\): void \{/m.test(src), 'the guard must be module level');
  assert.ok(/\^\[A-Za-z0-9\.-\]\+\$/.test(src), 'it must restrict the charset');
  assert.ok(/value\.includes\("\.\."\)/.test(src), 'it must reject ..');
  assert.ok(guardBefore('const certPath = path.join(this.certDir,'), 'the read path must be guarded');
  assert.ok(guardBefore('fs.writeFileSync(path.join(this.certDir,'), 'the WRITE path must be guarded');
  assert.ok(!/this\._assertSafeDomain/.test(src), 'the guard must not be a class method');
  const calls = (src.match(/assertSafeDomain\(domain\);/g) || []).length;
  assert.ok(calls === 3, 'exactly the three statement sites, found ' + calls);
});
