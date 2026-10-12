// =============================================================================
// Running a network probe is a privileged action (issue #115).
//
// POST /api/v1/network-test used to have no permission check at all: the only
// gate was the web auth middleware, which is mounted without a required
// permission, so ANY logged-in user - viewer included - could make the server
// and every online node probe arbitrary hosts and URLs (tcping, HTTP with up to
// 10 redirects, POST bodies). Nothing filters private ranges, so that is an SSRF
// pivot (cloud metadata at 169.254.169.254, internal panels, ...). The GET that
// returns the results was equally open, leaking internal reachability.
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

const { ROLES } = require('../lib/auth.ts');
const webServer = fs.readFileSync(path.join(__dirname, '..', 'lib', 'web-server.ts'), 'utf8');

test('the nettest permission exists and is not granted to viewer', () => {
  assert.deepEqual(
    Object.keys(ROLES).sort(),
    ['admin', 'operator', 'viewer'],
    'the built-in roles changed; re-check who may run probes'
  );
  assert.ok(ROLES.admin.permissions.includes('nettest:run'), 'admin must be able to run probes');
  assert.ok(ROLES.operator.permissions.includes('nettest:run'), 'operator must be able to run probes');
  assert.ok(
    !ROLES.viewer.permissions.includes('nettest:run'),
    'viewer must NOT be able to run probes or read their results'
  );
});

test('permissions are a whitelist, so an unknown code denies everyone', () => {
  // auth.ts checks role.permissions.includes(permission): a typo in the route
  // would 403 admin too. Pin that the route and the roles agree on the code.
  const used = webServer.match(/hasPermission\(str\(req\.user\), '([a-z]+:[a-z]+)'\)/g) || [];
  assert.ok(used.length > 0, 'no permission checks were found in web-server');
  const roles = Object.values(ROLES) as Array<{ permissions: string[] }>;
  for (const code of ['nettest:run']) {
    const granted = roles.some((r) => r.permissions.includes(code));
    assert.ok(granted, `${code} is used by a route but granted to nobody - that would 403 everyone`);
  }
});

test('both network-test routes require the permission', () => {
  const post = webServer.slice(
    webServer.indexOf("api.post('/network-test'"),
    webServer.indexOf("api.get('/network-test/:id'")
  );
  assert.ok(
    post.includes("hasPermission(str(req.user), 'nettest:run')"),
    'POST /network-test must require nettest:run'
  );
  // The check has to run before anything is dispatched to the nodes.
  assert.ok(
    post.indexOf("hasPermission(str(req.user), 'nettest:run')") < post.indexOf('nt.start('),
    'the permission check must come before the probe is started'
  );

  const get = webServer.slice(
    webServer.indexOf("api.get('/network-test/:id'"),
    webServer.indexOf("api.get('/network-test/:id'") + 900
  );
  assert.ok(
    get.includes("hasPermission(str(req.user), 'nettest:run')"),
    'GET /network-test/:id must require the same permission'
  );
  assert.ok(get.indexOf("hasPermission(str(req.user), 'nettest:run')") < get.indexOf('nt.get('), 'before reading a task');
});
