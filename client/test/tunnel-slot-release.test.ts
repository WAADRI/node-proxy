// =============================================================================
// Tunnel slot bookkeeping invariants (the "Client busy after a day of load" bug).
//
// client/client.ts is an entry script: requiring it would start the client and
// bind its ports, so its internals cannot be driven from a unit test. These
// checks therefore assert the source-level invariants that the bug violated:
//
//   1. every slot release goes through releaseSlot() (one delete call site);
//   2. a tunnel the server ends (_onEnd) and one that errors (_onError) both
//      release the slot - the leak was that only the target socket's 'close'
//      did, so any target holding its half open pinned a slot forever;
//   3. a full pool says so in the log instead of refusing silently.
//
// Point the env var NP_CLIENT_SOURCE at another copy to check a revision.
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

const SOURCE = process.env.NP_CLIENT_SOURCE || path.join(__dirname, '..', 'client.ts');
const source = fs.readFileSync(SOURCE, 'utf8');

// The legacy JSON-protocol tunnel path has its own bookkeeping, so scope every
// check to the mux path - that is the one every current server uses.
function sliceFrom(signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `end of ${signature} not found`);
  return source.slice(start, end);
}

const mux = sliceFrom('function handleMuxTunnel');

// The body of an arrow function assigned to `<name> = () => {`, up to the `};`
// that closes it.
function handlerBody(name: string): string {
  const start = mux.indexOf(`${name} = () => {`);
  assert.ok(start >= 0, `${name} handler not found`);
  const end = mux.indexOf('\n  };', start);
  assert.ok(end > start, `${name} handler body not found`);
  return mux.slice(start, end);
}

test('every mux slot release goes through releaseSlot()', () => {
  const deletes = mux.match(/activeTunnels\.delete\(/g) || [];
  assert.equal(
    deletes.length,
    1,
    'activeTunnels.delete must only exist inside releaseSlot(), so no mux end path can bypass the release'
  );
  assert.ok(handlerBody('const releaseSlot').includes('activeTunnels.delete('), 'releaseSlot must delete the slot');
});

test('a tunnel the server ends releases its slot', () => {
  const body = handlerBody('stream._onEnd');
  assert.ok(
    body.includes('releaseSlot()'),
    '_onEnd must release the slot: the server ends tunnels itself and a keep-alive target may never close its half'
  );
  assert.ok(
    body.includes('socket.end()') && body.includes('socket.destroy()'),
    '_onEnd must flush then make sure the socket actually dies'
  );
});

test('a tunnel that errors releases its slot', () => {
  assert.ok(handlerBody('stream._onError').includes('releaseSlot()'), '_onError must release the slot');
});

test('a full pool is reported instead of refusing silently', () => {
  const start = mux.indexOf('if (activeTunnels.size >= maxConcurrent())');
  assert.ok(start >= 0, 'the capacity check was not found (it must use the live limit, see concurrency-limit-push)');
  const body = mux.slice(start, start + 700);
  assert.ok(body.includes("'Client busy'"), 'the rejection must still be sent');
  assert.ok(body.includes('Client busy (active'), 'the rejection must be logged with the current occupancy');
});
