// =============================================================================
// Panel-driven concurrency limit.
//
// issue #53 moved node configuration out of the node, which left the concurrency
// limit compiled into the client image: raising it for the fleet meant shipping a
// new image. The server now owns it (the panel sets it) and pushes it: on auth_ok
// for new connections, and to every connected node whenever the client settings
// group changes.
//
// These checks pin the parts that would silently break that: a capacity check
// that reads the constant instead of the live value ignores the pushed limit, and
// a push that only happens on connect would leave running nodes on the old value.
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
const clientSource = fs.readFileSync(path.join(ROOT, 'client', 'client.ts'), 'utf8');
const wsServer = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'ws-server.ts'), 'utf8');
const webServer = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'web-server.ts'), 'utf8');
const manager = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'client-manager.ts'), 'utf8');

test('the client reads every capacity check from the live limit', () => {
  // A comparison against the image default would ignore a pushed limit. The
  // constant itself may still be mentioned (the helper's default, and the log
  // line that reports what it replaced).
  const rawChecks = clientSource.match(/>= CONFIG\.max_concurrent_requests/g) || [];
  assert.equal(rawChecks.length, 0, 'capacity checks must use maxConcurrent(), not the image default');
  const checks = clientSource.match(/>= maxConcurrent\(\)/g) || [];
  assert.ok(checks.length >= 3, `every capacity check must use maxConcurrent(), found ${checks.length}`);
  assert.ok(
    clientSource.includes('maxConcurrentRequests: maxConcurrent()'),
    'the node must report the EFFECTIVE limit, so the panel shows what is really enforced'
  );
});

test('the client applies a pushed limit, with bounds', () => {
  assert.ok(clientSource.includes("case 'limits'"), 'the client must handle the limits message');
  assert.ok(clientSource.includes("type: 'limits'"), 'the server message type must be declared');
  const start = clientSource.indexOf("case 'limits'");
  const body = clientSource.slice(start, start + 900);
  assert.ok(body.includes('Number.isFinite(requested)'), 'a non-numeric limit must be rejected');
  assert.ok(body.includes('requested < 1'), 'a limit of 0 would paralyse the node');
  assert.ok(body.includes('requested > 100000'), 'an absurd limit must be rejected');
  assert.ok(body.includes('maxConcurrentOverride = limit'), 'a valid limit must be applied');
});

test('the server pushes the limit on connect', () => {
  const authOk = wsServer.indexOf("type: 'auth_ok'");
  assert.ok(authOk > 0, 'auth_ok not found');
  const after = wsServer.slice(authOk, authOk + 600);
  assert.ok(after.includes("type: 'limits'"), 'a connecting node must receive the current limit');
  assert.ok(after.includes('currentMaxConcurrent()'), 'and it must be the current value, not a constant');
});

test('the server pushes the limit when the panel changes it', () => {
  for (const call of ['settingsManager.apply(group, body)', 'settingsManager.reset(group)']) {
    const at = webServer.indexOf(call);
    assert.ok(at > 0, `${call} not found`);
    const after = webServer.slice(at, at + 700);
    assert.ok(
      after.includes('pushConcurrencyLimit()'),
      `a change through ${call} must be pushed to connected nodes, not only to future connections`
    );
  }
  assert.ok(manager.includes('currentMaxConcurrent()'), 'the limit must come from the server config');
  assert.ok(manager.includes('pushConcurrencyLimit()'), 'the broadcast helper must exist');
});

test('the pushed value is the one admission uses', () => {
  const { ClientManager } = require('../lib/client-manager.ts');
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => logger };
  const cm = new ClientManager({ client: { max_concurrent: 250 } }, logger);
  assert.equal(cm.currentMaxConcurrent(), 250);
  const bare = new ClientManager({ client: {} }, logger);
  assert.equal(bare.currentMaxConcurrent(), 100, 'an unset limit falls back to the default');
});
