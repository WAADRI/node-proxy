// =============================================================================
// The WebSocket servers must cap the message size (issue #119).
//
// `new WebSocketServer({ noServer: true })` sets no maxPayload, so the ws library happily
// buffers a frame of any size in memory before the application sees it: a single peer
// could exhaust the process with one message, before authentication even matters. The cap
// matches the mux MAX_FRAME_SIZE (16 MiB) so legitimate batched frames still fit.
//
// Both modules need a full config to start, so this is a source-level invariant, like the
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

const ROOT = path.join(__dirname, '..');
const wsServer = fs.readFileSync(path.join(ROOT, 'lib', 'ws-server.ts'), 'utf8');
const entry = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

test('every WebSocketServer sets maxPayload', () => {
  for (const [name, src] of [['ws-server.ts', wsServer], ['server.ts', entry]]) {
    const opens = (src.match(/new WebSocketServer\(/g) || []).length;
    const capped = (src.match(/new WebSocketServer\(\{[^}]*maxPayload:/g) || []).length;
    assert.ok(opens > 0, name + ' must create a WebSocketServer');
    assert.ok(capped === opens, name + ' must cap ALL of them, found ' + capped + '/' + opens);
    assert.ok(!/new WebSocketServer\(\{ noServer: true \}\)/.test(src), name + ' must not leave an uncapped server');
  }
  assert.ok(/maxPayload: 16 \* 1024 \* 1024/.test(wsServer), 'the node gateway cap must match MAX_FRAME_SIZE');
});