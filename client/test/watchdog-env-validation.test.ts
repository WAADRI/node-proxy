// =============================================================================
// The watchdog knobs must be validated before use (issue #123).
//
// docker-entrypoint.sh read both variables straight from the environment.
// `WATCHDOG_STALE_SECONDS=abc` made `[ abc -gt 0 ]` fail, the `&&` short-circuited
// and the watchdog was silently DISABLED - the self-healing stopped working with no
// message at all. `WATCHDOG_CHECK_SECONDS=abc` made `sleep abc` fail immediately and
// turned the supervisor loop into a busy spin.
//
// The supervisor runs as PID 1 in the container, so this is a source-level
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

const src = fs.readFileSync(path.join(__dirname, '..', 'docker-entrypoint.sh'), 'utf8');

test('both watchdog variables are validated before use', () => {
  assert.ok(src.includes('case "$STALE" in'), 'STALE must be validated');
  assert.ok(src.includes('case "$CHECK" in'), 'CHECK must be validated');
  const nonDigit = (src.match(/\*\[!0-9\]\*\)/g) || []).length;
  assert.ok(nonDigit >= 2, 'both cases must reject non-digits, found ' + nonDigit);
  assert.ok(src.includes('WATCHDOG_STALE_SECONDS must be a non-negative integer'), 'and say so for STALE');
  assert.ok(src.includes('WATCHDOG_CHECK_SECONDS must be a non-negative integer'), 'and for CHECK');
  // The validation must come BEFORE the loop uses them.
  assert.ok(src.indexOf('case "$STALE" in') < src.indexOf('sleep "$CHECK"'), 'validation before the loop');
});
