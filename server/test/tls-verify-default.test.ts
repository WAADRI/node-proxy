// =============================================================================
// The client must verify the server certificate by default (issue #118).
//
// The config default was tls_reject_unauthorized: false, i.e. every client accepted ANY
// certificate. Anyone able to answer for server_url could therefore impersonate the server,
// read the node's proxied traffic and take its shared auth token. The call sites already
// honoured an explicit opt-out (`=== false ? false : true`), so only the default had to
// change - a self-signed setup now has to say so deliberately.
//
// The client is an entry script, so this is a source-level invariant, like the other tests
// in this suite.
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

test('TLS verification is on unless the operator opts out', () => {
  const legacy = fs.readFileSync(path.join(ROOT, 'client', 'client-legacy.ts'), 'utf8');
  assert.ok(/tls_reject_unauthorized: true,/.test(legacy), 'the default must verify');
  assert.ok(!/tls_reject_unauthorized: false,/.test(legacy), 'the permissive default must be gone');
  for (const rel of ['client/client.ts', 'client/client-legacy.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      /CONFIG\.tls_reject_unauthorized === false \? false : true/.test(src),
      rel + ' must only disable verification for an explicit false'
    );
  }
  const example = fs.readFileSync(path.join(ROOT, 'client', 'config.yaml.example'), 'utf8');
  assert.ok(/tls_reject_unauthorized: true/.test(example), 'the example config must document the default');
  assert.ok(/impersonate/.test(example), 'and warn what turning it off means');
});