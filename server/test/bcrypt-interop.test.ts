// =============================================================================
// The bcrypt interop must work at RUNTIME, not just compile (PR #163).
//
// The code called bcrypt.hashSync through a namespace import. This repo runs .ts directly
// through Node's type stripping, so that form is handed to Node as a REAL ESM namespace import
// of a CJS package: bcryptjs's named exports are not statically detectable, the namespace
// carries only `default`/`module.exports`, the function is undefined, and every login threw
// `TypeError: bcrypt.hashSync is not a function` - while the source-invariant tests stayed
// green (one of them even pinned the broken form).
//
// A dynamic import gives this file the SAME ESM namespace Node gives the real module, and the
// test then checks the property that matters: the default export - what a plain
// `import bcrypt from 'bcryptjs'` binds - must carry the API and complete a round trip.
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

type BcryptLike = {
  hashSync?: (plain: string, rounds: number) => string;
  compareSync?: (plain: string, hash: string) => boolean;
  default?: BcryptLike;
};

test('the ESM default export of bcryptjs carries a working hashing API', async () => {
  const ns = (await import('bcryptjs')) as unknown as BcryptLike;
  const api = ns.default ?? ns;
  assert.equal(typeof api.hashSync, 'function', 'the default export must expose hashSync');
  assert.equal(typeof api.compareSync, 'function', 'the default export must expose compareSync');
  const hash = api.hashSync!('probe-password', 10);
  assert.ok(hash.startsWith('$2'), 'the result must look like a bcrypt hash, got ' + hash.slice(0, 4));
  assert.equal(api.compareSync!('probe-password', hash), true, 'the hash must verify');
  assert.equal(api.compareSync!('wrong-password', hash), false, 'a wrong password must not verify');
});

test('auth.ts hashes through the default import', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8');
  // Line-anchored: a comment that merely mentions the old form must not satisfy these.
  assert.ok(/^import bcrypt from 'bcryptjs';/m.test(src), 'auth.ts must use the default import');
  assert.ok(!/^import \* as bcrypt/m.test(src), 'the namespace form leaves hashSync undefined at runtime');
  assert.ok(/bcrypt\.hashSync\(/.test(src), 'and still hashes with bcrypt');
});