// =============================================================================
// Audit queries must cover the rotated files too (issue #122).
//
// _rotate() renames audit.log to audit.1.log (shifting audit.N.log along), but
// query() read only this.logFile - so every record older than the newest file was
// invisible through the API, while the files were still on disk.
//
// AuditLogger needs config/logger to construct, so this is a source-level
// invariant, like the other tests in this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'audit.ts'), 'utf8');

test('query() reads the rotated files, oldest first', () => {
  const start = src.indexOf('query(options: AuditQueryOptions');
  assert.ok(start > 0, 'query() was not found');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(/for \(let i = this\.maxFiles; i >= 1; i--\)/.test(body), 'rotated files must be visited oldest first');
  assert.ok(/audit\.\$\{i\}\.log/.test(body), 'the rotated naming scheme must be used');
  assert.ok(body.includes('fs.existsSync(rotated)'), 'absent rotations must be skipped');
  assert.ok(/for \(const line of part\) lines\.push\(line\)/.test(body), 'and lines must be pushed without a giant spread');
  assert.ok(!/readFileSync\(this\.logFile/.test(body), 'the current file alone must no longer be the only source');
});
