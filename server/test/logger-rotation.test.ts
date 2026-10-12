// =============================================================================
// Log rotation must actually rotate (issue #122).
//
// rotate() only renamed the file, but the logger wrote through a pino.transport,
// i.e. a worker thread holding its own file descriptor: the process kept writing
// into the RENAMED file. Measured before the fix: after the rename the rotated
// file grew (418690 -> 523280 bytes) while server.log did not exist at all - the
// size limit never took effect and disk usage never came down.
//
// The fix moves the file destination to the main thread (pino.destination ->
// SonicBoom) and reopens it after the rename. This test drives a real logger and
// asserts where the lines land.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type * as NodeFs from 'fs';
import type * as NodeOs from 'os';
import type * as NodePath from 'path';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const fs: typeof NodeFs = require('fs');
const os: typeof NodeOs = require('os');
const path: typeof NodePath = require('path');

const { createLogger } = require('../lib/logger.ts');

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

test('after rotation new lines go to the new file, old ones stay behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nplog-'));
  const logFile = path.join(dir, 'server.log');
  // maxSize 1 so that a single line makes rotate() do its work.
  const log = createLogger({ logFile, logDir: dir, maxSize: 1, level: 'info' }) as {
    info(msg: string): void;
    rotate(): void;
    flush?: () => void;
    close?: () => void;
  };

  log.info('before-rotation');
  log.flush?.();
  await settle();

  log.rotate();
  log.info('after-rotation');
  log.flush?.();
  await settle();

  const rotated = fs.readdirSync(dir).filter((f) => f.startsWith('server.log.'));
  assert.equal(rotated.length, 1, 'exactly one rotated file must exist');

  assert.ok(fs.existsSync(logFile), 'the logger must reopen the original path (before the fix it stayed gone)');
  const current = fs.readFileSync(logFile, 'utf8');
  const old = fs.readFileSync(path.join(dir, rotated[0]), 'utf8');

  assert.ok(current.includes('after-rotation'), 'new lines belong to the new file');
  assert.ok(!current.includes('before-rotation'), 'and the rotated line must not be duplicated into it');
  assert.ok(old.includes('before-rotation'), 'the rotated file keeps what was already written');

  // Release the destination: an open file stream (and the rotation timer) would
  // otherwise keep the test process alive forever.
  log.close?.();
});
