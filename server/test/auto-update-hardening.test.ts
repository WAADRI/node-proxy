// =============================================================================
// The auto-update path must not turn remote metadata into local code execution
// (issue #120).
//
// Two holes, both reachable by whoever can tamper with the update source or the
// metadata channel (and update URLs may even be plain http):
//   * `data.version` was interpolated into the file name, the extraction
//     directory and shell commands, so `../` escaped the update directory and a
//     quote broke out into the shell;
//   * `data.post_update_script` was executed verbatim with execSync, i.e. the
//     metadata itself was the command line.
//
// These checks pin the guards. AutoUpdate needs a logger/config/storage to
// construct, so the assertions are made against the source (same approach as the
// other source-invariant tests in this suite).
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-update.ts'), 'utf8');

test('the version string is validated before it reaches the filesystem', () => {
  assert.ok(src.includes('private _safeVersion('), 'a version validator must exist');
  assert.ok(src.includes("v.includes('..')"), 'a version containing .. must be refused');
  assert.ok(
    src.includes('node-proxy-${this._safeVersion(data.version)}.zip'),
    'the download file name must use the validated version'
  );
  assert.ok(
    src.includes('this._insideDir(this.updateDir, `node-proxy-${this._safeVersion(this._downloadVersion)}`)'),
    'the extraction directory must use the validated version'
  );
  assert.ok(src.includes('private _insideDir('), 'paths must be contained in the update directory');
});

test('the post-update script can only come from inside the archive', () => {
  const start = src.indexOf('const postUpdateScript = data.post_update_script;');
  assert.ok(start > 0, 'the post-update script handling was not found');
  const block = src.slice(start, start + 1400);
  assert.ok(block.includes('path.isAbsolute(postUpdateScript)'), 'an absolute path must be refused');
  assert.ok(block.includes('this._insideDir(extractDir, postUpdateScript)'), 'it must resolve inside the archive');
  assert.ok(block.includes('fs.existsSync(scriptPath)'), 'a missing script must be refused, not attempted');
  assert.ok(block.includes('execFileSync'), 'it must run without a shell');
  assert.ok(
    !/execSync\(postUpdateScript\s*,/.test(src),
    'the metadata value must never be executed as a command line again'
  );
});

test('metadata and archive must come over https, and be pinned', () => {
  const checks = src.match(/protocol !== 'https:'/g) || [];
  assert.ok(checks.length >= 2, 'both the metadata check and the download must refuse non-https');
  assert.ok(!src.includes("require('http')"), 'plain http must not even be imported');
  assert.ok(
    src.includes('metadata carries no sha256'),
    'a missing checksum must refuse the update instead of installing unverified bytes'
  );
  assert.ok(/if \(!expectedSha256 \|\| typeof expectedSha256 !== 'string'\)/.test(src), 'the check must reject empty values');
});

test('the download is bounded and cleans up its handles', () => {
  assert.ok(src.includes('content-length'), 'the declared size must be checked before streaming');
  assert.ok(src.includes('512 * 1024 * 1024'), 'a hard byte limit must exist');
  assert.ok(src.includes('received += chunk.length'), 'the streamed size must be counted too');
  // Both handles are destroyed before the file is unlinked. (A window, not a
  // slice to the next marker: 'client.get(url.href' also appears in the metadata
  // fetch, which comes earlier in the file.)
  const failStart = src.indexOf('const fail = (err: Error');
  assert.ok(failStart > 0, 'the download failure helper was not found');
  const failBlock = src.slice(failStart, failStart + 500);
  assert.ok(failBlock.includes('req.destroy()'), 'the request must be destroyed');
  assert.ok(failBlock.includes('file.destroy()'), 'the write stream must be destroyed');
  assert.ok(
    failBlock.indexOf('file.destroy()') < failBlock.indexOf('fs.unlink('),
    'destroy before unlink, otherwise the unlink fails (routinely on Windows)'
  );
});

test('the shell is not used to interpolate the archive paths', () => {
  // Extract commands still use the platform tools, but the interpolated paths are
  // now built from the validated version only (see the first test). Comments are
  // stripped first: one of them mentions the old execSync call on purpose.
  const code = src.replace(/\/\/[^\n]*/g, '');
  const execs = code.match(/execSync\(/g) || [];
  assert.ok(execs.length <= 2, `only the two extraction commands may use a shell, found ${execs.length}`);
});
