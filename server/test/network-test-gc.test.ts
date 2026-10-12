// =============================================================================
// Finished network-test tasks must be reclaimed even without local tests (#122).
//
// The only cleanup lived inside _kick(), guarded by `tasks.size > 100` - and a
// nodes-only job (clients: "all" / [ids]) never calls _kick(), so its task map grew
// for the lifetime of the process (each task holding its targets and results).
//
// NetworkTest needs a logger to construct, so this is a source-level invariant,
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'network-test.ts'), 'utf8');

test('a timer sweeps finished tasks, independent of _kick()', () => {
  assert.ok(/setInterval\(\(\) => this\._gcTasks\(\), 60_000\)/.test(src), 'the sweep must be scheduled');
  assert.ok(/gcTimer\.unref\(\)/.test(src), 'and must not keep the process alive');
  const i = src.indexOf('_gcTasks() {');
  const gc = src.slice(i, i + 900);
  assert.ok(/this\.tasks\.delete\(id\)/.test(gc), 'it must delete finished tasks');
  assert.ok(/this\.tasks\.size <= 500/.test(gc), 'and a size cap must guarantee progress');
});
