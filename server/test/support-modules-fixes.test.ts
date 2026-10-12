// =============================================================================
// Small, unambiguous defects from the server support modules (issue #122).
//
// Each of these is a one-line bug with a disproportionate effect:
//   * acmeManager.stop() does not exist (acme.ts defines destroy()), so an ACME
//     deployment threw a TypeError inside shutdown() - the process-level handler
//     then exits with code 1 instead of shutting down cleanly;
//   * BandwidthLimiter.check() already consumes the global bucket, and the HTTP
//     path called it a second time for 'global', so the configured global rate
//     behaved like half of it (and invented a bogus per-client bucket named
//     'global');
//   * Bucket._refill() had no lower clamp on the elapsed time: a backwards clock
//     step (NTP) drove the bucket negative and throttled every request until real
//     time caught up.
//
// The first two need a running server / an HTTP request to observe, so the
// assertions are source-level, like the other tests in this suite.
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

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('shutdown calls a method that exists', () => {
  const server = read('server.ts');
  assert.ok(!/acmeManager\.stop\(\)/.test(server), 'acmeManager has no stop(); it must not be called');
  assert.ok(server.includes('acmeManager.destroy()'), 'shutdown must call destroy()');
  const acme = read('lib/acme.ts');
  assert.ok(/^\s+destroy\(\)/m.test(acme), 'and destroy() must still exist');
});

test('the global bandwidth bucket is charged exactly once per request', () => {
  const proxy = read('lib/proxy-http.ts');
  assert.ok(
    !proxy.includes("bw.check('global'"),
    "check() consumes the global bucket internally; asking for 'global' again double-charges it"
  );
  assert.ok(proxy.includes('bw.check(client.id, estimateSize)'), 'the per-client check must remain');
  const bw = read('lib/bandwidth.ts');
  assert.ok(/check\([\s\S]{0,400}globalBucket[\s\S]{0,120}tryConsume/.test(bw), 'check() must consume the global bucket');
});

test('a backwards clock step cannot drain a bucket', () => {
  const bw = read('lib/bandwidth.ts');
  assert.ok(
    bw.includes('Math.max(0, now - this.lastRefill)'),
    'elapsed must be clamped so a negative delta cannot subtract tokens'
  );
  assert.ok(
    /this\.tokens = Math\.min\(\s*this\.burst,/.test(bw),
    'and the refill must stay capped at the burst size'
  );
});
