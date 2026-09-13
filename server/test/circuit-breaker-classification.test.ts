// =============================================================================
// Circuit-breaker classification (the "SOCKS5 又无法连接了" regression).
//
// Symptom: after a day or two the proxy stopped working for every target. Cause:
// trackError() fed the breaker unconditionally, so target-level outcomes - a
// destination answering 404/502, or a request that took too long - were recorded
// as NODE failures. Five of those in a minute opened the breaker on a healthy
// node, which then rejected every target until a half-open probe happened to
// succeed. Combined with a server tunnel wait (15s) shorter than the client's
// own connect timeout (30s), even ordinary slow/blocked destinations counted.
//
// Two invariants are pinned here:
//   1. only node-level failures feed the breaker;
//   2. the server's tunnel wait stays ABOVE the client's connect timeout, which
//      is what makes a tunnel timeout a node-level signal at all.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const { ClientManager } = require('../lib/client-manager.ts');
const { CircuitBreaker } = require('../lib/circuit-breaker.ts');
const { DEFAULTS } = require('../lib/config.ts');

const CONFIG = {
  circuit_breaker: { error_threshold: 5, window_ms: 60000, recovery_timeout_ms: 30000, half_open_max_attempts: 3 },
  health_check: { ping_interval: 10000, ping_timeout: 5000, max_failures: 3 },
  mux: { initial_window: 65536, connection_window: 1048576 },
  client: { tunnel_idle_timeout: 0, tunnel_timeout: DEFAULTS.client.tunnel_timeout, request_timeout: 30000, max_concurrent: 100 },
};

function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => silentLogger() };
}

function newManager() {
  const cm = new ClientManager(CONFIG, silentLogger());
  // The server injects the breaker (client-manager only holds a null slot by
  // default), so wire in the real one.
  cm.circuitBreaker = new CircuitBreaker(CONFIG, silentLogger());
  return cm;
}

test('target-level failures never open the breaker', () => {
  const cm = newManager();
  // The target's own HTTP status, and a request that simply took too long.
  for (const type of ['upstream_404', 'upstream_500', 'upstream_502', 'upstream_503', 'timeout']) {
    for (let i = 0; i < 12; i++) cm.trackError('node-target', type);
    const state = breakerState(cm, 'node-target');
    assert.notEqual(state, 'open', `${type} x12 must not open the breaker (a target is not a node fault)`);
  }
});

test('node-level failures still open the breaker', () => {
  const cm = newManager();
  for (let i = 0; i < 5; i++) cm.trackError('node-send', 'send_error');
  assert.equal(breakerState(cm, 'node-send'), 'open', 'writing to the node failed - that is node health');
});

test('a node that never answers a tunnel is still demoted', () => {
  const cm = newManager();
  for (let i = 0; i < 5; i++) cm.trackError('node-silent', 'tunnel_timeout');
  assert.equal(
    breakerState(cm, 'node-silent'),
    'open',
    'an unanswered tunnel is node-level (the node reports target failures itself)'
  );
});

test('a slow target and a silent node are treated differently', () => {
  const cm = newManager();
  // Same count of failures, different classification: the target case must stay
  // closed while the node case opens.
  for (let i = 0; i < 6; i++) {
    cm.trackError('node-a', 'upstream_504');
    cm.trackError('node-b', 'tunnel_send_error');
  }
  assert.notEqual(breakerState(cm, 'node-a'), 'open');
  assert.equal(breakerState(cm, 'node-b'), 'open');
});

test('the server waits longer for a tunnel than the client waits to connect', () => {
  const { loadClientConfig } = require('../../client/lib/config-schema.ts');
  const client = loadClientConfig({ filePaths: [], env: {}, warn: () => {} });
  const serverWait = DEFAULTS.client.tunnel_timeout;
  const clientWait = client.tunnel_timeout;
  assert.ok(
    serverWait > clientWait,
    `server tunnel wait (${serverWait}ms) must exceed the client connect timeout (${clientWait}ms): ` +
      'otherwise the server gives up first and every slow/blocked destination looks like an unresponsive node'
  );
});

// Reads the breaker's state for a client id as a plain string ("closed" /
// "open" / "half_open"), or "unknown" when the breaker has no entry yet.
interface BreakerHolder {
  circuitBreaker: { getStatus(id: string): { state?: unknown } | null } | null;
}

function breakerState(cm: BreakerHolder, clientId: string): string {
  const status = cm.circuitBreaker ? cm.circuitBreaker.getStatus(clientId) : null;
  return status && status.state ? String(status.state) : 'unknown';
}