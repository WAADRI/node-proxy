// =============================================================================
// The mux must stop feeding the ws buffer without bound (issue #119).
//
// Frames go into _sendBuffer and _flushSendBuffer hands them to this.ws.send(), whose own
// buffer is the only queue - and nothing ever looked at ws.bufferedAmount, so a slow peer
// could make the process hold an arbitrarily large pending buffer. Above the high-water mark
// the batch is put back (exactly the pattern the connection-window check already uses) and a
// timer resumes the flush; the deferral budget is bounded, so a peer that stays slow degrades
// to the previous behaviour instead of stalling forever.
//
// The server needs a config to start, so this is a source-level invariant, like the other
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stream-mux.ts'), 'utf8');

test('the flush defers when the ws buffer is full, with a bounded budget', () => {
  assert.ok(/const OUTBOUND_HIGH_WATER = 4 \* 1024 \* 1024;/.test(src), 'a high-water mark must exist');
  assert.ok(/const MAX_DEFERRALS = 100;/.test(src), 'and a deferral budget');
  assert.ok(/private _deferrals = 0;/.test(src), 'the budget must be tracked per mux');
  assert.ok(/const buffered = \(this\.ws as \{ bufferedAmount\?: number \}\)\.bufferedAmount \?\? 0;/.test(src), 'the queued size must be read safely');
  assert.ok(/if \(buffered > OUTBOUND_HIGH_WATER && this\._deferrals < MAX_DEFERRALS\)/.test(src), 'and compared against both');
  assert.ok(/this\._sendBuffer\.unshift\(\.\.\.batch\);/.test(src), 'the batch must be put back');
  assert.ok(/_deferrals = 0; \/\/ a pass that actually sends resets the budget/.test(src), 'a successful pass must reset the budget');
  const guard = src.indexOf('buffered > OUTBOUND_HIGH_WATER');
  const send = src.indexOf('this.ws.send(sendData');
  assert.ok(guard > 0 && send > 0 && guard < send, 'the check must run BEFORE the send');
});