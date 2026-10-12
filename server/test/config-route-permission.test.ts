// =============================================================================
// GET /config must be admin-only (issue #117).
//
// It returned the whole configuration, which contains the auth token, the proxy and
// panel credentials and every other secret in the file, while requiring no permission
// at all - any authenticated user, including a viewer, could read it. Neither
// operator nor viewer holds system:config in ROLES, so the code makes it admin-only.
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

test('/config requires system:config', () => {
  const i = src.indexOf("api.get('/config',");
  assert.ok(i > 0, 'the route was not found');
  assert.ok(src.slice(i, i + 600).includes("hasPermission(str(req.user), 'system:config')"), 'the caller must hold system:config');
  const auth = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.ts'), 'utf8');
  const viewer = auth.slice(auth.indexOf('viewer: {'), auth.indexOf('};', auth.indexOf('viewer: {')));
  assert.ok(!/system:config/.test(viewer), 'viewer must NOT hold it');
});
