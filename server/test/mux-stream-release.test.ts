// =============================================================================
// A finished mux stream must be released on both sides.
//
// END_STREAM only half-closes a stream (Stream._handleFrame sets
// half_closed_remote / half_closed_local); the Stream is removed from
// mux.streams only by close() / reset() / RST_STREAM. Neither side used to call
// close() when a proxied HTTP request finished, so every request leaked its
// Stream - headers, buffered body and all - for the lifetime of the connection.
// Measured ~1.1 KB per request, i.e. ~1 GB/day at 10 req/s, on the server and on
// the node alike (issue #119).
//
// The regression is a MISSING call on several terminal paths, so these checks pin
// the invariant: every terminal response send is followed by stream.close().
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

const ROOT = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'ws-server.ts'), 'utf8');
const client = fs.readFileSync(path.join(ROOT, 'client', 'client.ts'), 'utf8');

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `end of ${signature} not found`);
  return source.slice(start, end);
}

test('the server releases the stream after a completed response', () => {
  const end = server.indexOf('res.end(body);');
  assert.ok(end > 0, 'the response path was not found');
  const after = server.slice(end, end + 400);
  assert.ok(
    after.includes('stream.close()'),
    'a completed request must close its stream, or it stays in mux.streams forever'
  );
});

test('the server releases the stream on the rate-limited path too', () => {
  const start = server.indexOf("clientManager.trackError(recClientId, 'bandwidth');");
  assert.ok(start > 0, 'the bandwidth rejection path was not found');
  assert.ok(
    server.slice(start, start + 400).includes('stream.close()'),
    'the early return must close the stream as well'
  );
});

test('every terminal response on the node closes its stream', () => {
  const fn = body(client, 'function executeMuxRequest');
  // Terminal sends end the response: '..., true);'
  const terminalSends = count(fn, ', true);');
  const closes = count(fn, 'stream.close();');
  assert.ok(terminalSends >= 3, `expected the terminal paths, found ${terminalSends}`);
  assert.ok(
    closes >= terminalSends,
    `every one of the ${terminalSends} terminal sends must close the stream, found ${closes}`
  );
});

test('the node closes the stream when it refuses for capacity', () => {
  const fn = body(client, 'function handleMuxRequest');
  assert.ok(fn.includes('Client busy'), 'the capacity rejection was not found');
  assert.ok(fn.includes('stream.close();'), 'the 503 path must close the stream too');
});
