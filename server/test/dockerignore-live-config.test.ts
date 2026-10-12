// =============================================================================
// The image must not bake the live config (issue #121).
//
// server/Dockerfile ends with `COPY . .`, so everything not listed in .dockerignore ends
// up in the image. config.local.yaml was excluded, but plain config.yaml was not: a
// developer's or operator's working copy - which holds the auth token and the proxy/panel
// credentials - was baked in. Worse, because the copy lived inside the image, later edits
// to the file were silently ignored unless the operator knew to pass a mount.
//
// docker-compose.yml mounts ./config.yaml read-only at runtime, so excluding it changes
// nothing for compose deployments and non-compose users get the built-in defaults.
//
// This is a repository-file invariant, like the other tests in this suite.
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

test('the live config is kept out of the image', () => {
  const di = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const lines = di.split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('config.yaml'), '.dockerignore must exclude config.yaml');
  assert.ok(lines.includes('config.local.yaml'), 'and must keep excluding the local one');
  assert.ok(lines.includes('.env'), 'and the env files');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.ok(/COPY \. \./.test(dockerfile), 'the Dockerfile must still COPY . . (the exclusion is what protects us)');
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.ok(/config\.yaml:\/app\/config\.yaml/.test(compose), 'compose must keep mounting the live config');
});