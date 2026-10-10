// =============================================================================
// Metadata edits must not synchronously rewrite the whole database (issue #122).
//
// setClientMetadata() and deleteConfigOverride() called _save(), which exports the
// entire sql.js database and rewrites the file - on every single edit. With a
// multi-megabyte DB that blocks the event loop for the duration of the export,
// while traffic writes already go through the batched _dirty path.
//
// Storage needs a database file to construct, so these are source-level
// invariants, like the other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storage.ts'), 'utf8');

function body(name: string): string {
  const start = src.indexOf(name + '(');
  assert.ok(start > 0, name + ' was not found');
  return src.slice(start, src.indexOf('\n  }', start));
}

test('metadata writes are batched instead of exporting the database', () => {
  for (const fn of ['setClientMetadata', 'deleteConfigOverride']) {
    const b = body(fn);
    assert.ok(b.includes('this._dirty = true'), fn + ' must mark the database dirty');
    assert.ok(!b.includes('this._save()'), fn + ' must not export the whole database synchronously');
  }
});
