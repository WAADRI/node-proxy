// =============================================================================
// Both client entry points must require authentication (issue #129 review).
//
// The auth gate added for #118 only covered JSON text frames in handleMessage. The
// binary mux path is a SECOND entry point: mux.onStream dispatched straight into
// handleMuxStream, so an unauthenticated peer could still trigger type === "request"
// (node-side SSRF) and tunnel_open (pivoting into the node network).
//
// client.ts is an entry script, so this is a source-level invariant, like the other
// tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'client.ts'), 'utf8');

test('the mux stream callback refuses unauthenticated streams', () => {
  const start = src.indexOf('mux.onStream((stream');
  assert.ok(start > 0, 'the onStream callback was not found');
  const body = src.slice(start, src.indexOf('});', start));
  assert.ok(/if \(!authenticated\) \{/.test(body), 'the mux entry must check authentication');
  assert.ok(/stream\.close\(\)/.test(body), 'and must close the stream instead of dispatching');
  assert.ok(
    body.indexOf('!authenticated') < body.indexOf('handleMuxStream(stream)'),
    'the check must run BEFORE any dispatch'
  );
  assert.ok(/Refusing mux stream/.test(body), 'and must say so in the log');
});
