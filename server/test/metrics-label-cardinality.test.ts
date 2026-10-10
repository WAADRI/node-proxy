// =============================================================================
// Label values must be bounded (issue #122).
//
// Every distinct label value becomes a permanent Prometheus time series, and two
// of them came straight from the wire: hostname (node-reported on every heartbeat,
// so a node could invent a new one each time) and the raw client_id (untruncated,
// unlike clientLoad which already used substring(0, 8)).
//
// Metrics needs a registry/config to start, so this is a source-level invariant,
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'metrics.ts'), 'utf8');

test('no label takes an unbounded wire value', () => {
  assert.ok(/function safeLabel\(value: unknown, max = 64\): string/.test(src), 'a label sanitizer must exist');
  assert.ok(!/client_id: clientId \|\| 'unknown'/.test(src), 'the raw client id must not be a label');
  assert.ok(!/hostname: c\.info\?\.hostname \|\| 'unknown'/.test(src), 'the raw hostname must not be a label');
  assert.ok(src.includes('client_id: safeLabel(clientId, 8)'), 'client ids must be truncated like clientLoad does');
  assert.ok(src.includes('hostname: safeLabel(c.info?.hostname, 32)'), 'hostnames must be capped and sanitized');
});
