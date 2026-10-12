// =============================================================================
// Login must also set an HttpOnly cookie (issue #117).
//
// webAuthMiddleware already reads req.cookies.token, but nothing ever set one - which
// is why the panel and its WebSocket had to carry the token in the URL, where it ends
// up in access logs and browser history. Setting the cookie (HttpOnly, SameSite=Strict,
// Secure when the request is) is the prerequisite for dropping the URL form; the JSON
// token is still returned so no client has to change yet.
//
// web-server.ts needs a full config to start, so this is a source-level invariant,
// like the other tests in this suite.
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

test('the login route sets an HttpOnly token cookie', () => {
  assert.ok(/res\.cookie\('token', token, \{/.test(src), 'the cookie must be set at login');
  const start = src.indexOf("res.cookie('token', token, {");
  const block = src.slice(start, src.indexOf('});', start));
  assert.ok(/httpOnly: true/.test(block), 'it must be HttpOnly');
  assert.ok(/sameSite: 'strict'/.test(block), 'and SameSite=Strict');
  assert.ok(/secure: Boolean\(req\.secure\)/.test(block), 'Secure when the request is');
  assert.ok(/maxAge: 24 \* 60 \* 60 \* 1000/.test(block), 'with the same 24h lifetime as the JWT');
  assert.ok(src.includes("res.json({ success: true, token, role, redirect: '/' });"), 'the JSON token must still be returned');
});
