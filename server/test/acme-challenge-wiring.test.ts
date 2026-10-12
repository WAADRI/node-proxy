// =============================================================================
// The ACME HTTP-01 challenge must actually be served (issue #122).
//
// ACMEManager.handleChallenge(req, res) existed but had NO caller: the token was stored
// in _challenges by challengeCreateFn and never handed to the certificate authority, so
// validation could not succeed and the whole feature was dead code. It is now tried
// before express on the HTTP server - which also means it bypasses the auth middleware,
// as required, since the CA fetches it unauthenticated over plain HTTP.
//
// server.ts is an entry script, so this is a source-level invariant, like the other tests
// in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');

test('handleChallenge is wired before express on the HTTP server', () => {
  const start = src.indexOf('http.createServer((req:');
  assert.ok(start > 0, 'the HTTP server must wrap the app');
  const block = src.slice(start, src.indexOf('});', start));
  assert.ok(
    block.includes('acmeManager.enabled && acmeManager.handleChallenge(req, res)'),
    'the challenge must be tried when ACME is enabled'
  );
  assert.ok(block.includes('app(req, res);'), 'and everything else must still reach express');
  assert.ok(
    block.indexOf('handleChallenge') < block.indexOf('app(req, res)'),
    'the challenge must be attempted BEFORE express, so it bypasses the auth middleware'
  );
});