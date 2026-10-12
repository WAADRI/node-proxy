// =============================================================================
// Trusted-proxy XFF resolution (the nginx follow-up to #162 / #206).
//
// clientIpFromSocket (lib/config.ts) is the ONE shared rule for the three
// places a client address is read: node registration, proxy logging and - via
// express - the panel. It is behavioural: real socket values, real header
// strings, including the attacks each rule must reject.
//
// Convention (express / nginx): the SOCKET peer is hop 0, so with N trusted proxies the client is
// entries[len - N]. #208 shipped len - 1 - N, which is one hop too far left: it trusted an entry
// the client itself could have prepended, and with nginx's standard
// `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (which appends the address nginx
// SAW, not its own) a one-entry chain fell through to the socket peer - so a node behind docker NAT
// was registered and displayed as the 172.x gateway instead of its real address.
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

test('one trusted hop (nginx default): the entry that proxy wrote is the rightmost one', () => {
  // The real deployment that reported this: nginx is the single trusted hop, it appends the
  // address it saw, so the header holds exactly the node address - which must win over the
  // socket peer (that peer is the docker NAT gateway, 172.19.0.1, not the node).
  assert.equal(
    clientIpFromSocket(SOCK, '203.0.113.55', 1),
    '203.0.113.55',
    'a single-entry chain written by the trusted proxy is the client, not the docker gateway'
  );

  // A client that sent its own XFF before the proxy lands LEFT of the proxy's entry and must
  // never be the answer: the proxy-appended value is the rightmost one.
  assert.equal(
    clientIpFromSocket(SOCK, 'spoofed-value, 198.51.100.7', 1),
    '198.51.100.7',
    'the leftmost (client-supplied) entry must never be the answer'
  );
});

test('two trusted hops walk exactly two entries from the right', () => {
  // client -> p1 -> p2 -> server: p1 wrote the client, p2 wrote p1, so the client is entries[0].
  assert.equal(clientIpFromSocket(SOCK, '203.0.113.9, 10.0.0.7', 2), '203.0.113.9');
  assert.equal(clientIpFromSocket(SOCK, '10.0.0.7, 203.0.113.9', 2), '10.0.0.7', 'positional, not heuristic');
});

test('a chain shorter than the declared hop count falls back to the socket peer', () => {
  assert.equal(
    clientIpFromSocket(SOCK, '9.9.9.9', 2),
    '127.0.0.1',
    'fewer entries than declared hops means the promised proxy never wrote the header'
  );
  assert.equal(clientIpFromSocket(SOCK, undefined, 1), '127.0.0.1', 'no header at all');
  assert.equal(clientIpFromSocket(V6_SOCK, '', 3), '::1', 'an empty header is no header');
});

test('the picked entry is normalized like the peer is (#206 rule applies to XFF too)', () => {
  assert.equal(clientIpFromSocket(SOCK, 'spoof, ::ffff:203.0.113.9', 1), '203.0.113.9');
});

test('array headers (node joins duplicates) are handled', () => {
  assert.equal(clientIpFromSocket(SOCK, ['spoof, 203.0.113.9', '127.0.0.1'], 1), '127.0.0.1');
});
