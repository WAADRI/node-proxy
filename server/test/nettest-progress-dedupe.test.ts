// =============================================================================
// Progress reports must be deduped and capped (issue #122).
//
// onClientProgress pushed every report straight into task.results, which is also
// the completion counter (`results.length >= expect` marks the task done). A node
// that sends the same index twice therefore finished the task early, and one that
// reports endlessly grew the array without bound.
//
// NetworkTest needs a logger to construct, so this is a source-level invariant,
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'network-test.ts'), 'utf8');

test('progress reports are deduped and bounded', () => {
  const start = src.indexOf('onClientProgress(clientId: string');
  assert.ok(start > 0, 'onClientProgress was not found');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(
    /task\.results\.some\(\(r\) => r\.clientId === clientId && r\.index === index\)/.test(body),
    'a repeated (client, index) must be ignored'
  );
  assert.ok(
    /if \(task\.results\.length >= Math\.max\(task\.expect, 1\)\) return;/.test(body),
    'the array must be capped at the expected count'
  );
  assert.ok(body.includes('\n      index,'), 'the parsed index must be the one stored');
  assert.ok(!body.includes('index: Number(msg.index)'), 'the raw field must not be pushed directly');
});
