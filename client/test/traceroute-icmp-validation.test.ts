// =============================================================================
// A traceroute hop must be validated as OUR probe (issue #123).
//
// The ICMP handler only looked at the OUTER type/code. The quoted datagram inside an
// ICMP error carries the original IP header and 8 UDP bytes, and the magic plus the
// per-hop token were written into the probe but never checked on the way back - so any
// unrelated ICMP message (another flow time-exceeded, a stray reply, a local forgery)
// was attributed to the current hop: wrong hops and a false "reached".
//
// NetworkTest needs a logger to construct, so this is a source-level invariant, like
// the other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'network-test.ts'), 'utf8');

test('the ICMP handler validates the quoted datagram', () => {
  const start = src.indexOf('_udpTraceroute(host: string)');
  assert.ok(start > 0, '_udpTraceroute was not found');
  const body = src.slice(start, src.indexOf('\n  _bufToIp', start));
  assert.ok(/const token = \(ttl \* 64 \+ Math\.floor\(Math\.random\(\) \* 200\)\) & 0xffff;/.test(body), 'the per-hop token must be kept');
  assert.ok(/readUInt16BE\(udpOff \+ 2\) !== basePort \+ ttl/.test(body), 'the inner destination port must be checked');
  assert.ok(/readUInt32BE\(udpOff \+ 8\) !== 0xfeedface/.test(body), 'the magic must be checked');
  assert.ok(/readUInt16BE\(udpOff \+ 12\) !== token/.test(body), 'the token must be checked');
  assert.ok(/if \(handled\) return;/.test(body), 'and a non-matching message must be ignored, not consumed');
  assert.ok(!/\.once\('message'/.test(body), 'the one-shot listener must be gone (it consumed unrelated replies)');
});
