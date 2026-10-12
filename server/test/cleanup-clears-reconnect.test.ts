// =============================================================================
// Cleanup must cancel a pending reconnect (issue #119).
//
// The reported "per-reconnect timer leak" does not accumulate: there is exactly one
// reconnectTimer and connect() clears it before scheduling another. What WAS wrong is that
// cleanupAll() - the path taken on shutdown/logout - never cleared it, so a client that was
// told to stop could (a) keep the process alive until the timer fired and (b) schedule a
// reconnect after it had been stopped. Both are fixed by clearing it there.
//
// client.ts is an entry script, so this is a source-level invariant, like the other tests in
// this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'client.ts'), 'utf8');

test('cleanupAll cancels the reconnect timer', () => {
  const start = src.indexOf('function cleanupAll()');
  assert.ok(start > 0, 'cleanupAll was not found');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/clearTimeout\(reconnectTimer\)/.test(body), 'the pending reconnect must be cancelled');
  assert.ok(/reconnectTimer = null;/.test(body), 'and the handle cleared');
  const cancel = body.indexOf('clearTimeout(reconnectTimer)');
  const heartbeat = body.indexOf('stopHeartbeat()');
  assert.ok(cancel > 0 && heartbeat > 0 && cancel < heartbeat, 'cancelled before the rest of the teardown');
  // There is only one timer, cleared before being re-scheduled - so nothing accumulates.
  const clears = (src.match(/clearTimeout\(reconnectTimer\)/g) || []).length;
  assert.ok(clears >= 2, 'connect() and cleanupAll() must both clear it, found ' + clears);
});