// =============================================================================
// Regression tests for the shared-cache privacy fix (issue #18)
// Credentialed requests must bypass the cache entirely, and responses that
// forbid caching (private / no-store / no-cache / Set-Cookie / Vary) must
// never be stored.
// =============================================================================
// Migrated to TypeScript (issue #42, Phase 2). CJS-style: values are exported
// via module.exports only; the type-only export below makes TypeScript treat
// this as a module (eliminating global-scope collisions).
// =============================================================================
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
export type {};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RequestCache } = require('../lib/cache.ts');

interface CacheTest {
  makeKey(method: string, url: string, headers: Record<string, string>): string | null;
  set(key: string | null, body: Buffer, statusCode: number, headers: Record<string, string>): void;
  get(key: string | null): Buffer | null;
  destroy(): void;
  readonly cache: Map<string, unknown>;
  readonly maxBodySize: number;
}

function makeCache(t: Record<string, (fn: () => void) => void>): CacheTest {
  const c = new RequestCache({ cache: { enabled: true, default_ttl: 5000 } }, { info: () => {} }) as CacheTest;
  t.after(() => c.destroy());
  return c;
}

function fill(cache: CacheTest, entries: [string, Record<string, string>][]): void {
  for (const [k, headers] of entries) {
    cache.set(k, Buffer.from('body'), 200, headers);
  }
}

test('makeKey: GET without credentials yields a key', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  assert.ok(c.makeKey('GET', 'http://origin.example/a?b=2&a=1', {}));
});

test('makeKey: credentialed requests bypass the cache (null key)', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  assert.strictEqual(c.makeKey('GET', 'http://origin.example/me', { cookie: 'user=A' }), null);
  assert.strictEqual(c.makeKey('GET', 'http://origin.example/me', { Cookie: 'user=A' }), null);
  assert.strictEqual(c.makeKey('GET', 'http://origin.example/me', { authorization: 'Bearer xyz' }), null);
  assert.strictEqual(c.makeKey('GET', 'http://origin.example/me', { Authorization: 'Bearer xyz' }), null);
});

test('makeKey: only GET is cached', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  assert.strictEqual(c.makeKey('POST', 'http://origin.example/a', {}), null);
  assert.strictEqual(c.makeKey('PUT', 'http://origin.example/a', {}), null);
});

test('set: rejects private/no-store/no-cache responses', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  fill(c, [
    ['k-private', { 'cache-control': 'private, max-age=60' }],
    ['k-nostore', { 'cache-control': 'no-store' }],
    ['k-nocache', { 'cache-control': 'no-cache' }],
    ['k-cc-upper', { 'Cache-Control': 'PUBLIC, NO-STORE' }],
  ]);
  assert.strictEqual(c.cache.size, 0);
});

test('set: rejects responses carrying Set-Cookie', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  fill(c, [
    ['k-sc', { 'set-cookie': 'sid=abc' }],
    ['k-sc2', { 'cache-control': 'public, max-age=60', 'set-cookie': 'sid=abc' }],
  ]);
  assert.strictEqual(c.cache.size, 0);
});

test('set: Vary on anything but Accept is not shared-cache safe', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  fill(c, [
    ['k-vary-cookie', { vary: 'Cookie' }],
    ['k-vary-auth', { vary: 'Authorization' }],
    ['k-vary-star', { vary: '*' }],
    ['k-vary-lang', { vary: 'Accept-Language' }],
  ]);
  assert.strictEqual(c.cache.size, 0);
});

test('set: Vary Accept and plain public GET are cacheable', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  fill(c, [
    ['k-vary-accept', { vary: 'Accept' }],
    ['k-vary-accept-lower', { vary: 'accept' }],
    ['k-public', {}],
    ['k-public-cc', { 'cache-control': 'public, max-age=60' }],
  ]);
  assert.strictEqual(c.cache.size, 4);
});

test('set: error and oversized responses are not stored', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  c.set('k-500', Buffer.from('err'), 500, {});
  c.set('k-big', Buffer.alloc(c.maxBodySize + 1), 200, {});
  assert.strictEqual(c.cache.size, 0);
});

test('end-to-end policy: user A private data never leaks to user B', (t: Record<string, (fn: () => void) => void>) => {
  const c = makeCache(t);
  const keyA = c.makeKey('GET', 'http://origin/me', { cookie: 'user=A' });
  const keyB = c.makeKey('GET', 'http://origin/me', { cookie: 'user=B' });
  assert.strictEqual(keyA, null);
  assert.strictEqual(keyB, null);
  assert.strictEqual(c.get(keyA), null);
  // Even a public request can never store this private response
  const pubKey = c.makeKey('GET', 'http://origin/me', {});
  assert.ok(pubKey);
  c.set(pubKey, Buffer.from('user-data:A'), 200, { 'cache-control': 'private, no-store', 'set-cookie': 'sid=A' });
  assert.strictEqual(c.cache.size, 0);
});