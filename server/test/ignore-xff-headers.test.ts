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

test('the socket peer is the only source of the client IP', () => {
  assert.ok(!/x-forwarded-for/.test(ws), 'ws-server must not read X-Forwarded-For');
  assert.ok(!/x-real-ip/.test(ws), 'ws-server must not read X-Real-IP');
  assert.ok(/const clientIp = req\.socket\.remoteAddress \|\| '';/.test(ws), 'ws-server must use the socket peer');
  assert.ok(!/x-forwarded-for/.test(http), 'proxy-http must not read X-Forwarded-For');
  const fn = http.slice(http.indexOf('function clientIp('), http.indexOf('}', http.indexOf('function clientIp(')));
  assert.ok(/return norm\(req\.socket && req\.socket\.remoteAddress\);/.test(fn), 'proxy-http must use the socket peer');
  assert.ok(/replace\(\/\^::ffff:\/i/.test(fn), 'and still normalise IPv4-mapped IPv6');
});
