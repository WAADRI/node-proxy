// =============================================================================
// Client-supplied proxy headers must not decide the client IP (issue #117).
//
// ws-server.ts took X-Forwarded-For / X-Real-IP first and only then the socket, and
// proxy-http.ts clientIp() did the same. With no reverse proxy in front (the default
// compose setup) that let any client pick the address recorded for it, shown in the
// panel, written to the audit log and used by ACL checks - and it contradicted the
// panel own `trust proxy = false`.
//
// Both modules need a full config to start, so this is a source-level invariant, like
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

const ROOT = path.join(__dirname, '..', 'lib');
const ws = fs.readFileSync(path.join(ROOT, 'ws-server.ts'), 'utf8');
const http = fs.readFileSync(path.join(ROOT, 'proxy-http.ts'), 'utf8');

test('the client IP ignores proxy headers unless the operator opted in', () => {
  // Header reads now go through the shared, opt-in-gated helper
  // (lib/config.ts clientIpFromSocket, trusted_proxy_hops). The invariant here
  // covers the DEFAULT (no opt-in) behaviour of all three consumers.
  assert.ok(/clientIpFromSocket/.test(ws), 'ws-server resolves through the shared helper');
  assert.ok(/trusted_proxy_hops/.test(ws), 'and gates it on the operator-declared hop count');
  const regPath = ws.slice(ws.indexOf('const clientIp = clientIpFromSocket'), ws.indexOf('// Create StreamMux'));
  assert.ok(/x-forwarded-for/.test(regPath) === false || /trusted_proxy_hops/.test(regPath), 'the header is only consulted behind the trusted-hops gate');
  assert.ok(!/x-real-ip/i.test(ws), 'X-Real-IP is not used anywhere (it has no hop semantics)');
  assert.ok(/clientIpFromSocket/.test(http), 'proxy-http resolves through the shared helper');
  assert.ok(/trusted_proxy_hops/.test(http), 'and gates it on the operator-declared hop count');
});
