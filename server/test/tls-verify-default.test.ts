// =============================================================================
// Certificate verification must actually be ON for the MAIN client (issue #118 / PR #186).
//
// The first version of this fix only changed client-legacy.ts - but the shipped client.ts loads
// its config from client/lib/config-schema.ts, where the key lived in FIXED with default false.
// FIXED entries accept neither config.yaml nor environment values, so all three routes failed to
// enable verification, and the example config added by that PR documented a setting the loader
// ignored. A source-string test could not catch that, so this test loads the real schema module
// and checks the properties the loader actually uses.
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

type SchemaEntry = { key: string; env?: string[]; type?: string; default?: unknown; desc?: string };
type SchemaModule = { SCHEMA: SchemaEntry[]; FIXED: SchemaEntry[]; defaults: () => Record<string, unknown> };

const ROOT = path.join(__dirname, '..', '..');

test('the main client schema has verification configurable AND on by default', () => {
  // Same form the other tests in this suite use: require with an explicit .ts extension.
  const mod = require('../../client/lib/config-schema.ts') as SchemaModule;
  assert.ok(Array.isArray(mod.SCHEMA), 'SCHEMA must be exported');
  assert.ok(Array.isArray(mod.FIXED), 'FIXED must be exported');

  const inSchema = mod.SCHEMA.find((e) => e.key === 'tls_reject_unauthorized');
  const inFixed = mod.FIXED.find((e) => e.key === 'tls_reject_unauthorized');
  assert.ok(inSchema, 'the key must be in SCHEMA, otherwise config.yaml and the env cannot set it');
  assert.equal(inFixed, undefined, 'and must NOT be in FIXED - those values are ignored by design');
  assert.equal(inSchema.default, true, 'the default must verify certificates');
  assert.deepEqual(inSchema.env, ['TLS_REJECT_UNAUTHORIZED'], 'and the documented env var must be wired');
  assert.equal(mod.defaults().tls_reject_unauthorized, true, 'the loaded defaults must report true');
});

test('both client entry points only disable verification for an explicit false', () => {
  for (const rel of ['client/client.ts', 'client/client-legacy.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      /CONFIG\.tls_reject_unauthorized === false \? false : true/.test(src),
      rel + ' must only disable verification for an explicit false'
    );
  }
  const legacy = fs.readFileSync(path.join(ROOT, 'client', 'client-legacy.ts'), 'utf8');
  assert.ok(/tls_reject_unauthorized: true,/.test(legacy), 'the legacy loader default must verify too');
  assert.ok(!/tls_reject_unauthorized: false,/.test(legacy), 'the permissive default must be gone');
});