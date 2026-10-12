// =============================================================================
// The UDP relay's peer admission, exercised as REAL code (issue #126 / #119).
//
// PR #126 restricts the relay to the peer of the TCP control connection via the exported
// isRelayPeer(). That predicate is the whole security decision, and this suite drives it
// directly instead of grepping for it - the review's recurring finding was that source-level
// invariants stayed green while the runtime behaviour was wrong (a namespace import that threw
// on every login, a flow-control window that never moved).
//
// The cases below are the ones that decide whether this is an open relay:
//   * a foreign address must lose;
//   * the same address must win, in mapped (::ffff:) and plain form;
//   * loopback must match across dual-stack spellings, or local clients break;
//   * unknown/empty endpoints must lose (fail closed).
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');

async function loadPredicate(): Promise<(source: string, controlPeer: string) => boolean> {
  const ns = (await import('../../server/lib/proxy-socks5.ts')) as unknown as {
    isRelayPeer?: (s: string, c: string) => boolean;
  };
  assert.equal(typeof ns.isRelayPeer, 'function', 'isRelayPeer must be exported');
  return ns.isRelayPeer as (s: string, c: string) => boolean;
}

test('the UDP relay only accepts datagrams from its control peer', async () => {
  const isRelayPeer = await loadPredicate();

  // The core property: a third party is rejected.
  assert.equal(isRelayPeer('203.0.113.7', '198.51.100.9'), false, 'a foreign address must be rejected');
  assert.equal(isRelayPeer('10.0.0.1', '10.0.0.10'), false, 'a prefix of the peer address is still foreign');
  assert.equal(isRelayPeer('198.51.100.9', '198.51.100.9'), true, 'the owner must be accepted');

  // IPv4-mapped IPv6 peers are the same host.
  assert.equal(isRelayPeer('::ffff:198.51.100.9', '198.51.100.9'), true, 'mapped form must match');
  assert.equal(isRelayPeer('198.51.100.9', '::FFFF:198.51.100.9'), true, 'comparison must be case-insensitive');
  assert.equal(isRelayPeer('::ffff:203.0.113.7', '198.51.100.9'), false, 'mapped form of a foreign host is still foreign');

  // Dual-stack loopback: the control peer may be ::1 while the datagram arrives as 127.0.0.1.
  assert.equal(isRelayPeer('127.0.0.1', '::1'), true, 'loopback must match across spellings');
  assert.equal(isRelayPeer('::1', '127.0.0.1'), true, 'and in the other direction');
  assert.equal(isRelayPeer('127.0.0.1', '127.0.0.2'), false, 'but only loopback, not every 127/8 address');

  // Fail closed when either endpoint is unknown.
  assert.equal(isRelayPeer('', '198.51.100.9'), false, 'an unknown sender must be rejected');
  assert.equal(isRelayPeer('198.51.100.9', ''), false, 'an unknown control peer must be rejected');
  assert.equal(isRelayPeer('', ''), false, 'two unknown endpoints must be rejected');
});