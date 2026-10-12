// =============================================================================
// The liveness beacon must not follow a symlink (issue #123).
//
// LIVENESS_FILE is a predictable path in a world-writable directory, and the client
// runs as root on a bare-metal install (the systemd unit sets no User=). A local user
// could therefore pre-create the path as a symlink and have the client truncate and
// overwrite any root-owned file every 10 seconds.
//
// client.ts is an entry script (requiring it starts the client), so this is a
// source-level invariant, like the other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'client.ts'), 'utf8');

test('the beacon is written with O_NOFOLLOW and mode 0600', () => {
  const start = src.indexOf('function writeLivenessBeacon');
  assert.ok(start > 0, 'writeLivenessBeacon was not found');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(!body.includes('writeFileSync(LIVENESS_FILE'), 'the symlink-following write must be gone');
  assert.ok(/fs\.constants\.O_NOFOLLOW \?\? 0/.test(body), 'O_NOFOLLOW must degrade safely where it does not exist');
  assert.ok(/fs\.openSync\(LIVENESS_FILE, flags, 0o600\)/.test(body), 'the beacon must be created 0600');
  assert.ok(/fs\.closeSync\(fd\)/.test(body), 'and the descriptor must be closed');
});
