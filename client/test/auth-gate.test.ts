// =============================================================================
// The node must not act on server messages before the token was accepted, and a
// protocol message must not be able to kill the process (issue #118).
//
// handleMessage dispatched every message type unconditionally, so whoever the
// socket was pointed at - a MITM on a plain ws:// control connection, or simply
// a wrong/malicious server_url - could send `request` (node-side SSRF),
// `tunnel_open` (reach into the node's network), `net_test` (probing) and
// `auth_error` (process.exit(1), i.e. a restart loop under docker) without any
// credential being checked.
//
// client.ts is an entry script (requiring it starts the client), so these are
// source-level invariants, like the other tests in this suite.
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

test('the client tracks whether the session is authenticated', () => {
  assert.ok(src.includes('let authenticated = false;'), 'an authentication flag must exist');
  assert.ok(/>\s*authenticated = true;/.test(src) || src.includes('authenticated = true;'), 'auth_ok must set it');
  const assignments = (src.match(/^\s*authenticated = false;/gm) || []).length;
  assert.ok(
    assignments >= 2,
    `it must be reset on connect AND on auth_error (found ${assignments} assignments)`
  );
});

test('messages are refused before authentication', () => {
  const start = src.indexOf('function handleMessage(msg: ServerMsg) {');
  assert.ok(start > 0, 'handleMessage was not found');
  const head = src.slice(start, start + 700);
  assert.ok(
    head.includes("if (!authenticated && msg.type !== 'auth_ok' && msg.type !== 'auth_error')"),
    'only the handshake may pass before authentication'
  );
  assert.ok(
    head.indexOf('!authenticated') < head.indexOf('switch (msg.type)'),
    'the gate must run before the dispatch switch'
  );
});

test('auth_error cannot kill the process', () => {
  const start = src.indexOf("case 'auth_error':");
  assert.ok(start > 0, 'the auth_error case was not found');
  const block = src.slice(start, src.indexOf("case 'info_ok':", start));
  assert.ok(!block.includes('process.exit('), 'a server message must not terminate the client');
  assert.ok(block.includes('authenticated = false;'), 'the session must be marked unauthenticated');
  assert.ok(!/intentionalClose = true;/.test(block), 'the close path must stay reconnecting, with backoff');
  assert.ok(!src.includes('process.exit(1)'), 'the client must not exit(1) on protocol input');
});
