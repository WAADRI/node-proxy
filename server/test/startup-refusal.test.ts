// =============================================================================
// The startup refusal, verified as a PROCESS (issue #199, last verification layer).
//
// Everything else about this guard was covered by source-invariant tests - and one of them stayed
// green while the guard was dead code for every configuration. So this test does what none of
// them could: it starts server.ts with a config that still uses a shipped password and asserts
// the observable outcome - exit code 1, the guidance on stderr, and no listener.
//
// CONFIG_PATH is honoured by server/lib/config.ts, so the child gets its own config file. Ports
// are high and unique to this test so it cannot collide with the E2E job or a local run.
//
// Note: with pino's default batching the guidance line could be lost entirely in the exit race;
// the refusal path therefore also writes to stderr (see the guard in server.ts). The SonicBoom
// "not ready yet" noise that pino's own exit hook emits on Windows is NOT asserted either way -
// it is cosmetic and its presence must not make this test flaky.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type * as NodeFs from 'fs';
import type * as NodePath from 'path';
import type * as NodeChild from 'child_process';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const fs: typeof NodeFs = require('fs');
const path: typeof NodePath = require('path');
const child: typeof NodeChild = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
const CONFIG = [
  'server:',
  '  host: "127.0.0.1"',
  '  web_port: 39011',
  '  http_proxy_port: 39012',
  '  socks5_port: 39013',
  'auth:',
  '  token: "a-real-custom-token"',
  '  proxy:',
  '    enabled: false',
  '    password: proxy-pass',
  '  web:',
  '    enabled: true',
  '    username: admin',
  '    password: admin123',
  'logging:',
  '  level: info',
  '  file: ""',
  '',
].join('\n');

test('a deployment still on the shipped panel password refuses to start, and says why', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'np-refusal-'));
  const cfgPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(cfgPath, CONFIG);

  try {
    const result = child.spawnSync(process.execPath, ['server.ts'], {
      cwd: SERVER_DIR,
      env: { ...process.env, CONFIG_PATH: cfgPath, ALLOW_DEFAULT_CREDENTIALS: '', ALLOW_DEFAULT_TOKEN: '' },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(result.status, 1, 'the process must refuse to start (stderr: ' + String(result.stderr).slice(-400) + ')');
    assert.ok(
      /Shipped default credentials are still in use: auth\.web\.password = admin123/.test(String(result.stderr)),
      'and the operator must be told which setting is at fault'
    );
    assert.ok(
      /ALLOW_DEFAULT_CREDENTIALS=1/.test(String(result.stderr)),
      'and how to opt out for a throwaway setup'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});