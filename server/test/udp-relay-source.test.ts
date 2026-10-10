// =============================================================================
// The SOCKS5 UDP relay must only serve the peer that owns the control connection,
// and must not outlive it (issue #114).
//
// The relay socket was bound on 0.0.0.0 and its 'message' handler relayed any
// datagram, with no check on the source: a third party that learned the port
// (any client can open an association and read BND.PORT) could push traffic
// through the node and receive the replies - an unauthenticated open relay.
// Nothing ever wrote cleanupState.udpSocket either, so closing the TCP control
// connection left the relay bound and the association in the map.
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

const { isRelayPeer } = require('../lib/proxy-socks5.ts');

test('datagrams from the control peer are relayed', () => {
  assert.equal(isRelayPeer('203.0.113.9', '203.0.113.9'), true);
  // IPv4-mapped form: the listener reports the peer one way, the datagram the other.
  assert.equal(isRelayPeer('::ffff:203.0.113.9', '203.0.113.9'), true);
  assert.equal(isRelayPeer('203.0.113.9', '::ffff:203.0.113.9'), true);
  assert.equal(isRelayPeer('::FFFF:203.0.113.9', '::ffff:203.0.113.9'), true);
  // Loopback in either representation is the same host.
  assert.equal(isRelayPeer('::1', '127.0.0.1'), true);
  assert.equal(isRelayPeer('127.0.0.1', '::1'), true);
});

test('datagrams from anyone else are refused', () => {
  assert.equal(isRelayPeer('198.51.100.7', '203.0.113.9'), false, 'a different third party');
  assert.equal(isRelayPeer('203.0.113.10', '203.0.113.9'), false, 'a neighbour address');
  assert.equal(isRelayPeer('', '203.0.113.9'), false, 'an unknown source');
  assert.equal(isRelayPeer('203.0.113.9', ''), false, 'an unknown peer');
});

test('the relay handler drops datagrams from other sources', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy-socks5.ts'), 'utf8');
  const start = src.indexOf("udpServer.on('message'");
  assert.ok(start > 0, 'the relay message handler was not found');
  const handler = src.slice(start, start + 900);
  // Keyed on the CONTROL CONNECTION peer: the declared DST.ADDR is 0.0.0.0 for
  // standard clients (RFC 1928 section 7), so it cannot be the comparison target.
  assert.ok(
    handler.includes('isRelayPeer(rinfo.address, relayPeer)'),
    'the handler must validate the datagram source against the control peer'
  );
  assert.ok(/if \(!isRelayPeer[\s\S]{0,400}return;/.test(handler), 'a non-peer source must return early');
});

test('cleanup releases the relay association', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy-socks5.ts'), 'utf8');
  const cleanup = src.slice(src.indexOf('function cleanup()'), src.indexOf("socket.on('data'"));
  assert.ok(cleanup.includes('udpAssociations'), 'cleanup must look at the UDP associations');
  assert.ok(
    cleanup.includes('assoc.socket !== socket'),
    'the association must be matched by its control socket'
  );
  assert.ok(cleanup.includes('udpAssociations.delete('), 'and removed from the map');
  assert.ok(/udpServer as dgram\.Socket\)\.close\(\)/.test(cleanup), 'and its relay socket closed');
});
