// =============================================================================
// /client/:id/events and /client/:id/traffic must whitelist the id (issue #122).
//
// They were the only /client/:id routes that did not check the id exists, and
// they hand it to storage, which builds SQL by template string. Quote doubling
// makes a single value position safe today, but the reachable half of that cut -
// a caller-controlled string arriving at the query - is closed by resolving the
// id through the manager first, exactly as the neighbouring routes do.
//
// These routes need a running server to exercise, so the assertions are
// source-level, like the other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'web-server.ts'), 'utf8');

function route(methodAndPath: string): string {
  const start = src.indexOf(`api.${methodAndPath}`);
  assert.ok(start > 0, `${methodAndPath} was not found`);
  const end = src.indexOf('\n  });', start);
  assert.ok(end > start, `end of ${methodAndPath} was not found`);
  return src.slice(start, end);
}

test('both routes resolve the id before querying storage', () => {
  for (const [routeName, reader] of [
    ["get('/client/:id/events'", 'getClientEvents('],
    ["get('/client/:id/traffic'", 'getTrafficStats('],
  ] as Array<[string, string]>) {
    const body = route(routeName);
    const check = body.indexOf('clientManager.getById(');
    const read = body.indexOf(reader);
    assert.ok(check > 0, `${routeName} must look the client up`);
    assert.ok(read > check, `${routeName} must look it up BEFORE reading from storage`);
    assert.ok(body.includes('Client not found'), `${routeName} must 404 on an unknown id`);
    assert.ok(
      body.includes(`${reader}client.id`) || body.includes(`${reader}\n      client.id`) || /\(\s*client\.id/.test(body),
      `${routeName} must query with the canonical id, not the raw request value`
    );
    assert.ok(
      !new RegExp(`${reader.replace('(', '\\(')}pstr\\(req\\.params\\.id\\)`).test(body),
      `${routeName} must not pass the raw request value to storage`
    );
  }
});
