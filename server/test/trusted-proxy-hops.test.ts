// =============================================================================
// Trusted-proxy XFF resolution (the nginx follow-up to #162 / #206).
//
// clientIpFromSocket (lib/config.ts) is the ONE shared rule for the three
// places a client address is read: node registration, proxy logging and - via
// express - the panel. It is behavioural: real socket values, real header
// strings, including the attacks each rule must reject.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const { clientIpFromSocket } = require('../lib/config.ts');

const SOCK = { remoteAddress: '::ffff:127.0.0.1' } as const;
const V6_SOCK = { remoteAddress: '::1' } as const;

test('no trusted hops: the raw peer wins and headers are ignored (the #162 rule)', () => {
  assert.equal(clientIpFromSocket(SOCK, '9.9.9.9, 8.8.8.8', 0), '127.0.0.1', 'mapped form is still stripped for display (#206)');
  assert.equal(clientIpFromSocket(V6_SOCK, '9.9.9.9', 0), '::1', 'a pure IPv6 peer keeps its form');
});

test('one trusted hop: picks the entry before the last, ignoring client-forged leftmost values', () => {
  // nginx appends the address it saw; the client may ALSO have sent its own
  // XFF header before the proxy, which lands left of the real client entry.
  assert.equal(
    clientIpFromSocket(SOCK, 'spoofed-value, 203.0.113.9, 127.0.0.1', 1),
    '203.0.113.9',
    'the leftmost entry is attacker-controlled and must never be the answer'
  );
});

test('short chains fall back to the socket peer instead of trusting the client-supplied value', () => {
  assert.equal(clientIpFromSocket(SOCK, '9.9.9.9', 1), '127.0.0.1',
    'a chain shorter than the declared hop count means the proxy did not add it - the header is client-supplied');
  assert.equal(clientIpFromSocket(SOCK, undefined, 1), '127.0.0.1', 'no header at all');
});

test('the picked entry is normalized like the peer is (#206 rule applies to XFF too)', () => {
  assert.equal(clientIpFromSocket(SOCK, 'spoof, ::ffff:203.0.113.9, ::ffff:127.0.0.1', 1), '203.0.113.9');
});

test('array headers (node joins duplicates) are handled', () => {
  assert.equal(clientIpFromSocket(SOCK, ['spoof, 203.0.113.9', '127.0.0.1'], 1), '203.0.113.9');
});
