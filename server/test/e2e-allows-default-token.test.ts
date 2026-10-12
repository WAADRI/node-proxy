// =============================================================================
// The E2E workflow must opt out of the shipped-default guards explicitly (#182, #185).
//
// Those guards refuse to start the server while auth.token / auth.web.password are still the
// values committed to this repository - deliberately, because they are public. The E2E job
// starts the server with the repo default config.yaml, so it has to opt out with the
// documented escape hatch instead of the guards being weakened.
//
// Only the workflow is asserted here: the guards themselves live in unmerged PRs, so a check
// against server.ts would fail on this branch. Setting the variable is harmless before they
// land, which is why this fix stands on its own.
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

const ROOT = path.join(__dirname, '..', '..');

test('the E2E starts the server with the documented opt-out', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', '端到端测试.yml'), 'utf8');
  assert.ok(
    /ALLOW_DEFAULT_TOKEN=1 node server\.ts/.test(wf),
    'the E2E server start must set ALLOW_DEFAULT_TOKEN=1'
  );
  assert.ok(
    /^.*ALLOW_DEFAULT_TOKEN=1.*$/m.test(wf) && wf.indexOf('ALLOW_DEFAULT_TOKEN=1') > wf.indexOf('node-proxy-server.log') - 500,
    'the opt-out must be on the server start line, not somewhere unrelated'
  );
  assert.ok(/auth_token: node-proxy-default-token/.test(wf), 'the job must still exercise the default token path');
  assert.ok(/node-proxy-default-token/.test(wf), 'and the default token must remain part of the setup');
});