// =============================================================================
// Circuit breaker state must not survive a node re-registration (user report).
//
// A node update restarts the client. The in-flight tunnels from BEFORE the
// disconnect time out on the server and each timeout counted as a failure, so
// the breaker opened. When the node came back it registered as half_open, and
// the only path out of half_open is N consecutive PROXY successes - on a quiet
// deployment those never happen, so the panel showed "testing" forever. A
// reconnect proves the transport is back; the stale state belongs to the dead
// connection, like the pending records remove() already discards.
//
// Drives the real ClientManager + CircuitBreaker: accumulate failures to OPEN,
// then re-register through add() and assert the breaker starts closed.
// A genuinely failing node re-opens via the normal path, which is also pinned
// here (failures after reconnect are counted afresh).
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

function silentLogger() {
  const l: Record<string, unknown> = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };
  l.child = () => l;
  return l;
}

const CONFIG = {
  server: {}, health_check: {}, client: {},
  circuit_breaker: { error_threshold: 3, window_ms: 60000, recovery_timeout_ms: 1000, half_open_max_attempts: 2 },
};

function makeManager() {
  const log = silentLogger() as never;
  const manager = new ClientManager(CONFIG, log);
  manager.circuitBreaker = new CircuitBreaker(CONFIG, log);
  return manager;
}

// A stand-in socket for add(); only identity matters to the manager.
function fakeWs() {
  return { readyState: 1, send() {}, close() {}, on() {}, ping() {} } as never;
}

test('breaker state from the dead connection is dropped on re-registration', () => {
  const manager = makeManager();
  manager.add(fakeWs(), { clientId: 'node-r', hostname: 't' });

  // The disconnect of an update: in-flight work times out on the server.
  manager.circuitBreaker?.onFailure('node-r', 'tunnel_timeout');
  manager.circuitBreaker?.onFailure('node-r', 'tunnel_timeout');
  manager.circuitBreaker?.onFailure('node-r', 'tunnel_timeout');
  assert.equal(manager.circuitBreaker?.getState('node-r'), 'open', 'precondition: breaker opened by the dead connection');

  // The node comes back (this is what the user did: update + restart).
  manager.add(fakeWs(), { clientId: 'node-r', hostname: 't' });
  assert.equal(manager.circuitBreaker?.getState('node-r'), 'closed',
    'the panel must show the node as healthy after it re-registered (was stuck on "testing")');
  assert.equal(manager.circuitBreaker?.getStatus('node-r').failures, 0, 'and the old failure count must be gone');
});

test('a genuinely failing node re-opens after the reset - the reset is not a shield', () => {
  const manager = makeManager();
  manager.add(fakeWs(), { clientId: 'node-r', hostname: 't' });
  // It reconnected but keeps failing every request it receives:
  for (let i = 0; i < 3; i++) manager.circuitBreaker?.onFailure('node-r', 'tunnel_error');
  assert.equal(manager.circuitBreaker?.getState('node-r'), 'open',
    'a node that keeps failing must still be isolated; only the STALE state from the previous connection is dropped');
});

test('resetForReconnect stays quiet and tolerates a breaker without the method', () => {
  const log = silentLogger() as never;
  const breaker = new CircuitBreaker(CONFIG, log);
  breaker.onFailure('n', 'x'); breaker.onFailure('n', 'x'); breaker.onFailure('n', 'x');
  assert.equal(breaker.getState('n'), 'open');
  breaker.resetForReconnect('n');
  assert.equal(breaker.getState('n'), 'closed', 'an existing entry is dropped');
  breaker.resetForReconnect('ghost'); // absent entry: must not throw
  // A duck-typed breaker without the optional method must not break add():
  const minimal: { isAllowed(): boolean; reset(): void; onSuccess(): void; onFailure(): void; getState(): string; getAllStatuses(): Record<string, unknown>; getStatus(): Record<string, unknown>; cleanup(): void } = {
    isAllowed: () => true, reset: () => {}, onSuccess: () => {}, onFailure: () => {},
    getState: () => 'closed', getAllStatuses: () => ({}), getStatus: () => ({}), cleanup: () => {},
  };
  const manager = makeManager();
  (manager as { circuitBreaker: unknown }).circuitBreaker = minimal;
  manager.add(fakeWs(), { clientId: 'n2', hostname: 't' }); // must not throw
  assert.ok(manager.getById('n2'), 'registration completed despite the minimal breaker');
});
