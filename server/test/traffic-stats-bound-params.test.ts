// =============================================================================
// Traffic stats must use bound parameters (issue #122).
//
// recordTraffic checked for an existing row with db.exec(), which cannot take
// parameters: it interpolated the client id with quote-doubling and period_start RAW.
// The surrounding UPDATE/INSERT already bound their values, so this was the odd one
// out - and prepare()+bind() removes both the quoting concern and the numeric
// interpolation in one step. free() runs in a finally block, like the other readers.
//
// The server needs a config to start, so this is a source-level invariant, like the
// other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storage.ts'), 'utf8');

test('the traffic_stats existence check binds its parameters', () => {
  // Match the DEFINITION, not a type declaration or call site.
  const i = src.indexOf('recordTraffic(clientId: string');
  assert.ok(i > 0, 'recordTraffic was not found');
  const body = src.slice(i, src.indexOf('getTrafficStats(', i));
  assert.ok(body.includes("this._prepare('SELECT id FROM traffic_stats WHERE client_id = ? AND period_start = ?')"), 'the check must be prepared');
  assert.ok(/existing\.bind\(\[clientId, periodStart\]\)/.test(body), 'and must bind both values');
  assert.ok(/existing\.free\(\);/.test(body), 'and free the statement');
  // Match the CALL form: the explanatory comment legitimately mentions exec().
  assert.ok(!/\.exec\(/.test(body), 'the exec() call must be gone from this path');
  assert.ok(!/replace\(\/'\/g/.test(body), 'and so must the quote-doubling');
});
