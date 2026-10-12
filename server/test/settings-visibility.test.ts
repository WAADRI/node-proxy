// =============================================================================
// GET /settings must only expose groups the caller may act on (issue #117).
//
// The route returned settingsManager.list() in full to any authenticated user, so a
// viewer could read the routing, circuit breaker, bandwidth, client and cache
// configuration - and only the `editable` map hinted that they were not theirs. The
// values are now filtered by the same predicate that gates edits: routing:strategy
// (operator and admin) or system:config (admin), so an operator still sees routing
// and nothing else, exactly as they can edit.
//
// web-server.ts needs a full config to start, so this is a source-level invariant,
// like the other tests in this suite.
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

test('the settings list is filtered by the edit predicate', () => {
  const start = src.indexOf("api.get('/settings'");
  assert.ok(start > 0, 'the route was not found');
  // Slice to the route's own terminator: the body contains `});` inside the 501 guard.
  const body = src.slice(start, src.indexOf('\n  });', start));
  assert.ok(/canEditSettings\(req\.user, g\)/.test(body), 'the edit predicate must be reused for reads');
  assert.ok(/if \(!allowed\) delete visible\[g\];/.test(body), 'disallowed groups must be removed');
  assert.ok(/res\.json\(\{ success: true, \.\.\.visible, editable \}\)/.test(body), 'only the visible groups must be returned');
  assert.ok(!/res\.json\(\{ success: true, \.\.\.data, editable \}\)/.test(body), 'the unfiltered spread must be gone');
  assert.ok(/routing: 'routing:strategy'/.test(src), 'operator must keep routing via routing:strategy');
});
