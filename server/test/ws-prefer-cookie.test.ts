// =============================================================================
// The WebSocket handshake must prefer the cookie over the URL token (issue #117).
//
// extractToken read ?token= FIRST, so the panel had to put the token in the URL,
// where it lands in access logs and browser history. A browser sends the cookie
// automatically on a same-origin WebSocket upgrade, so cookie-first lets the panel
// keep working unchanged; the query form stays as a transitional fallback.
//
// server.ts is an entry script, so this is a source-level invariant, like the other
// tests in this suite.
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

test('the cookie is read before the URL token', () => {
  const fn = src.slice(src.indexOf('function extractToken('));
  const cookieAt = fn.indexOf("cookie.match(/token=");
  const queryAt = fn.indexOf('urlObj.query.token');
  assert.ok(cookieAt > 0, 'the cookie must be read');
  assert.ok(queryAt > 0, 'the query fallback must still exist');
  assert.ok(cookieAt < queryAt, 'the cookie must come FIRST');
  assert.ok(/TRANSITIONAL fallback/.test(fn), 'and the query form must be marked transitional');
  assert.ok(/Bearer /.test(fn), 'the Authorization header must still work');
});
