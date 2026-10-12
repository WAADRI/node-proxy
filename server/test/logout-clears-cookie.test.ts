// =============================================================================
// Logout must at least clear the cookie the middleware accepts (issue #117).
//
// The route was a bare `res.json({ success: true })`, so a client that had been
// authenticated by cookie (webAuthMiddleware reads req.cookies.token) stayed logged
// in. A stateless JWT cannot be revoked here, so the handler now clears that cookie
// and documents the limitation next to the code instead of leaving it implicit.
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

test('logout clears the auth cookie and documents the JWT limitation', () => {
  const start = src.indexOf("app.post('/api/logout'");
  assert.ok(start > 0, 'the logout route was not found');
  const body = src.slice(start, src.indexOf('});', start));
  assert.ok(/res\.clearCookie\('token'\);/.test(body), 'the cookie must be cleared');
  assert.ok(body.indexOf('clearCookie') < body.indexOf('res.json'), 'before answering');
  assert.ok(/stateless JWT/.test(body), 'and the limitation must be documented in place');
});
