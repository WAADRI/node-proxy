// =============================================================================
// A tunnel target must be validated before connecting (issue #118/#113).
//
// Both tunnel handlers passed the port straight to net.connect. An out-of-range
// value (99999, -1, 3.5) makes it throw SYNCHRONOUSLY (ERR_SOCKET_BAD_PORT), and
// handleMuxTunnel had no try/catch, so the throw escaped the handler entirely:
// no tunnel_error was ever sent and the server sat waiting for its own timeout.
// An empty host is equally bogus - net.connect would resolve it to localhost.
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
const assert: typeof NodeAssert = require('assert/strict') as typeof NodeAssert;
const fs: typeof NodeFs = require('fs');
const path: typeof NodePath = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'client.ts'), 'utf8');

function handler(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} was not found`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next > 0 ? next : undefined);
}

test('both tunnel handlers validate the target before connecting', () => {
  const guards = (src.match(/Number\.isInteger\(port\)/g) || []).length;
  assert.ok(guards >= 2, `every connect site needs the guard, found ${guards}`);
  for (const name of ['handleMuxTunnel', 'handleTunnelOpen']) {
    const body = handler(name);
    const guard = body.indexOf('Number.isInteger(port)');
    const connect = body.indexOf('socket.connect(');
    assert.ok(guard > 0, `${name} must validate the port`);
    assert.ok(connect > 0, `${name} must still connect`);
    assert.ok(guard < connect, `${name} must validate BEFORE connecting`);
    assert.ok(body.includes('!host'), `${name} must refuse an empty host (it means localhost)`);
    assert.ok(/Number\.isInteger\(port\)[\s\S]{0,200}failTunnel\(/.test(body), `${name} must report a tunnel_error`);
  }
});

test('a rejected target does not leave a timeout or a socket behind', () => {
  const mux = handler('handleMuxTunnel');
  assert.ok(
    /!Number\.isInteger\(port\)[\s\S]{0,160}socket\.destroy\(\)/.test(mux),
    'the mux path must destroy the socket it already created'
  );
  const legacy = handler('handleTunnelOpen');
  assert.ok(
    /!Number\.isInteger\(port\)[\s\S]{0,160}clearTimeout\(timeout\)/.test(legacy),
    'the legacy path must clear the timeout it already armed'
  );
});
