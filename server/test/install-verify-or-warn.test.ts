// =============================================================================
// The installer must verify the download, or say it did not (issue #121).
//
// deploy/install.sh fetches a client binary and installs it as a root-run systemd service,
// with no integrity check of any kind. No checksum or signature is published yet, so the
// best available behaviour is: verify when the caller supplies CLIENT_SHA256, refuse on a
// mismatch, and otherwise WARN LOUDLY - failing closed would break every existing
// installation on upgrade, which is not a trade we make silently.
//
// The script is invoked by hand, so this is a source-level invariant, like the other tests
// in this suite.
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

test('the installer verifies the binary or warns that it did not', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'deploy', 'install.sh'), 'utf8');
  assert.ok(/CLIENT_SHA256:-/.test(sh), 'it must accept an expected digest');
  assert.ok(/sha256sum|shasum -a 256/.test(sh), 'it must compute a digest');
  assert.ok(/refusing to install/.test(sh), 'a mismatch must abort');
  assert.ok(/exit 1/.test(sh), 'and really stop');
  assert.ok(/the downloaded binary is NOT verified/.test(sh), 'a missing digest must be reported');
  const verify = sh.indexOf('CLIENT_SHA256:-');
  const chmod = sh.indexOf('chmod +x "${INSTALL_DIR}/node-proxy-client.tmp"');
  assert.ok(verify > 0 && chmod > 0 && verify < chmod, 'verification must run BEFORE the binary is made executable');
});