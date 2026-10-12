// =============================================================================
// The README must warn that the dev-binary links are mutable (issue #121).
//
// The quick-start points at releases/latest/download/client-*, which is a MUTABLE dev build
// rebuilt on every push to main: no version to pin, nothing to reproduce. deploy/install.sh
// runs the binary as root, so downloading equals executing - the README has to say so, offer
// building from a reviewed commit, and be honest that no checksum or signature is published
// (so a digest check only compares machines, it does not establish provenance).
//
// Documentation is part of the attack surface, so this is asserted like any other invariant.
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

const ROOT = path.join(__dirname, '..', '..');

test('the dev-binary quick start carries an integrity warning', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/没有完整性保证/.test(readme), 'the README must state there is no integrity guarantee');
  assert.ok(/可变的 `dev` 构建/.test(readme), 'and that the build is mutable');
  assert.ok(/git checkout <commit>/.test(readme), 'it must offer building from a reviewed commit');
  assert.ok(/sha256sum node-proxy-client-linux-x64/.test(readme), 'and show how to compare digests');
  assert.ok(/不发布\*\*校验和文件或签名/.test(readme), 'and be honest that no checksum is published');
  const download = readme.indexOf('releases/latest/download/client-linux-x64');
  const warning = readme.indexOf('没有完整性保证');
  assert.ok(download > 0 && warning > 0 && warning > download, 'the warning must follow the links it is about');
});