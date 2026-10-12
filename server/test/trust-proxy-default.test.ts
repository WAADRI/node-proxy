// =============================================================================
// The panel must not take req.ip from a client-supplied header (issue #117).
//
// app.set('trust proxy', 1) made express read the right-most X-Forwarded-For entry,
// so a client talking to the panel directly could forge its own address - the value
// used in the login-failure audit line and by any IP-based check.
//
// The trust is now driven by the operator-declared reverse-proxy hop count
// (server.trusted_proxy_hops, #162 follow-up): default 0 keeps `trust proxy`
// false; declaring N hops switches express to N - the same count the
// node-registration and proxy-logging paths use (clientIpFromSocket), so all
// three consumers resolve one address.
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

test('proxy headers are trusted only for the declared hop count', () => {
  assert.ok(/app\.set\('trust proxy', trustedProxyHops > 0 \? trustedProxyHops : false\)/.test(src),
    'the setting must follow server.trusted_proxy_hops');
  assert.ok(/const trustedProxyHops = Number\(config\.server\?\.trusted_proxy_hops\) \|\| 0;/.test(src),
    'derived from the operator-declared count');
  assert.ok(!/app\.set\('trust proxy', 1\)/.test(src), 'a hard-coded single hop must be gone');
});
