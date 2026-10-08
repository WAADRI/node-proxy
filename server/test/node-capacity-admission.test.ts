// =============================================================================
// Admission against node-reported capacity (the "server 8 / node 100" split).
//
// The server used to admit purely on its own bookkeeping: its count of tunnels
// it had dispatched and not yet torn down. That cannot see a node which is full
// for reasons of its own - leaked slots (2026-10), or simply a limit lower than
// the server's (the panel was set to 1000 while the node caps at 100). The node
// then answered every extra tunnel with "Client busy" and nothing on the server
// side explained why.
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

const { clientLoad, clientCapacity, ClientManager } = require('../lib/client-manager.ts');

function fakeNode(stats: Record<string, unknown>, pending: Partial<{ requests: number; tunnels: number }> = {}) {
  return {
    stats: { activeRequests: 0, activeTunnels: 0, maxConcurrentRequests: 0, ...stats },
    pendingRequests: { size: pending.requests || 0 },
    pendingTunnels: { size: pending.tunnels || 0 },
  };
}

const CONFIG = {
  client: { max_concurrent: 100, tunnel_timeout: 35000, request_timeout: 30000, tunnel_idle_timeout: 60000 },
  circuit_breaker: { error_threshold: 5, window_ms: 60000, recovery_timeout_ms: 30000, half_open_max_attempts: 3 },
  health_check: { ping_interval: 10000, ping_timeout: 5000, max_failures: 3 },
};

function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => silentLogger() };
}

test('the node-reported limit wins over a higher server setting', () => {
  // The exact misconfiguration from the field: panel set to 1000, node caps at 100.
  const node = fakeNode({ maxConcurrentRequests: 100 });
  assert.equal(clientCapacity(node, 1000), 100, 'a node that accepts 100 must not be given 1000');
});

test('the server setting still caps a node that reports more', () => {
  const node = fakeNode({ maxConcurrentRequests: 5000 });
  assert.equal(clientCapacity(node, 100), 100, 'the server policy is an upper bound');
});

test('a node that reports nothing falls back to the server setting', () => {
  assert.equal(clientCapacity(fakeNode({}), 250), 250, 'older nodes send no capacity');
  assert.equal(clientCapacity(fakeNode({ maxConcurrentRequests: 0 }), 250), 250, '0 means "not reported"');
  assert.equal(clientCapacity(undefined, 250), 250, 'unknown node');
});

test('the node-reported occupancy wins over the server bookkeeping', () => {
  // The leak: node full at 100, server convinced only 8 were open.
  const node = fakeNode({ activeTunnels: 100 }, { tunnels: 8 });
  assert.equal(clientLoad(node, 'tunnel'), 100, 'the node knows better than the server');

  // ...and the server's count is still a floor while a node report is missing.
  const quiet = fakeNode({ activeTunnels: 0 }, { tunnels: 7 });
  assert.equal(clientLoad(quiet, 'tunnel'), 7, 'never admit below what the server dispatched');
});

test('requests and tunnels are counted separately', () => {
  const node = fakeNode({ activeTunnels: 100, activeRequests: 3 }, { tunnels: 0, requests: 0 });
  assert.equal(clientLoad(node, 'tunnel'), 100);
  assert.equal(clientLoad(node, 'request'), 3, 'a full tunnel pool must not block plain HTTP requests');
});

test('ClientManager reports saturation from the same numbers', () => {
  const cm = new ClientManager(CONFIG, silentLogger());
  // An unknown node has no load; capacity falls back to the server's setting.
  assert.equal(cm.capacityOf('nope'), 100);
  assert.equal(cm.loadOf('nope', 'tunnel'), 0);
  assert.equal(cm.isSaturated('nope', 'tunnel'), false);
});

test('both proxy paths admit through isSaturated', () => {
  // Guards against a revert to the server-only check, which is what made the
  // 2026-10 incident invisible on the panel.
  const root = path.join(__dirname, '..', 'lib');
  const paths: Array<[string, string[]]> = [
    ['proxy-socks5.ts', ['tunnel']],
    ['proxy-http.ts', ['tunnel', 'request']],
  ];
  for (const [file, kinds] of paths) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(src.includes('clientManager.isSaturated('), `${file} must admit through isSaturated`);
    for (const kind of kinds) {
      assert.ok(src.includes(`isSaturated(client.id, '${kind}')`), `${file} must check the ${kind} pool`);
    }
    assert.ok(
      !src.includes('pendingTunnels.size >= (config.client?.max_concurrent'),
      `${file} must not go back to the server-only capacity check`
    );
  }
});
