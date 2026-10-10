// =============================================================================
// The panel must not take req.ip from a client-supplied header (issue #117).
//
// app.set('trust proxy', 1) made express read the right-most X-Forwarded-For entry,
// so a client talking to the panel directly could forge its own address - the value
// used in the login-failure audit line and by any IP-based check.
//
// The server needs a full config to start, so this is a source-level invariant, like
// the other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'web-server.ts'), 'utf8');

test('proxy headers are not trusted by default', () => {
  assert.ok(src.includes("app.set('trust proxy', false)"), 'the default must be false');
  assert.ok(!/app\.set\('trust proxy', 1\)/.test(src), 'the permissive setting must be gone');
});
