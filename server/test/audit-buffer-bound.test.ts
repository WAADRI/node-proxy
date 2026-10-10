// =============================================================================
// A failing audit write must not grow the buffer without bound (issue #122).
//
// _flush() put the whole failed batch back with `this.buffer.unshift(...entries)`.
// While writes keep failing (disk full, read-only mount, permissions) the buffer
// doubles every 5s flush, and a spread of that size eventually throws
// RangeError: Maximum call stack size exceeded - which the process-level handler
// treats as fatal and exits the process.
//
// AuditLogger needs config/logger to construct, so this is a source-level
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'audit.ts'), 'utf8');

test('the audit buffer is bounded when a write fails', () => {
  assert.ok(!/unshift\(\.\.\.entries\)/.test(src), 'the unbounded spread must be gone');
  assert.ok(/this\.buffer = \[\.\.\.entries, \.\.\.this\.buffer\]\.slice\(0, maxBuffered\)/.test(src), 'the buffer must be capped when re-queued');
  assert.ok(/const maxBuffered = Math\.max\(this\.bufferSize \* 10, 1000\)/.test(src), 'and the cap must be derived, not unbounded');
});
