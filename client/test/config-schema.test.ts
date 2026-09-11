// =============================================================================
// Client configuration tests (issue #53, item 4).
//
// A node is configurable through exactly four settings: the endpoint, the auth
// credential and the region/tags it reports. Every tuning knob is a fixed
// internal: a config.yaml entry or an environment variable for one of them must
// have no effect. These tests exist because re-adding such a mapping is silent
// otherwise - the value simply starts applying again, which is the failure mode
// that made per-node tuning untrustworthy in the first place.
//
// CJS-style module, matching the server tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type * as NodeFs from 'fs';
import type * as NodeOs from 'os';
import type * as NodePath from 'path';

const test = require('node:test');
// Value imports are not available here: client/package.json is "type": "commonjs",
// so only type-only imports (erased by Node's type stripping) may use import syntax.
const assert: typeof NodeAssert = require('node:assert/strict');
const fs: typeof NodeFs = require('fs');
const os: typeof NodeOs = require('os');
const path: typeof NodePath = require('path');

interface SchemaEntry {
  key: string;
  env: string[];
  type: 'string' | 'number' | 'boolean';
  default: string | number | boolean;
}

interface ConfigModule {
  SCHEMA: SchemaEntry[];
  FIXED: SchemaEntry[];
  loadClientConfig(opts?: {
    filePaths?: string[];
    env?: Record<string, string | undefined>;
    warn?: (message: string) => void;
  }): Record<string, string | number | boolean>;
  renderExampleYaml(): string;
}

const { SCHEMA, FIXED, loadClientConfig, renderExampleYaml }: ConfigModule = require('../lib/config-schema.ts');

const CONFIGURABLE = ['server_url', 'auth_token', 'region', 'tags'];

function writeTempConfig(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-client-config-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, body);
  return file;
}

function removeTempConfig(file: string): void {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

test('a node is configurable through the documented keys only', () => {
  assert.deepEqual(
    SCHEMA.map((it: SchemaEntry) => it.key),
    CONFIGURABLE,
  );
  // region keeps its legacy NODE_REGION alias
  const region = SCHEMA.find((it: SchemaEntry) => it.key === 'region');
  assert.deepEqual(region?.env, ['REGION', 'NODE_REGION']);
});

test('every fixed internal keeps its default and stays out of the schema', () => {
  const cfg = loadClientConfig({ filePaths: [], env: {} });
  assert.ok(FIXED.length > 0, 'expected fixed internals to be declared');
  for (const it of FIXED) {
    assert.equal(cfg[it.key], it.default, `${it.key} must keep its default`);
    assert.ok(
      !SCHEMA.some((s: SchemaEntry) => s.key === it.key),
      `${it.key} must not be configurable`,
    );
  }
});

test('fixed internals cannot be set through the environment', () => {
  const env: Record<string, string> = {};
  for (const it of FIXED) env[it.env[0]] = it.type === 'number' ? '1' : 'true';
  const cfg = loadClientConfig({ env, warn: () => {} });
  for (const it of FIXED) {
    assert.equal(cfg[it.key], it.default, `${it.key} must ignore ${it.env[0]}`);
  }
});

test('fixed internals cannot be set through config.yaml', () => {
  const file = writeTempConfig(
    ['heartbeat_interval: 1', 'max_concurrent_requests: 1', 'server_url: ws://example.test/ws', ''].join('\n'),
  );
  try {
    const cfg = loadClientConfig({ filePaths: [file], env: {}, warn: () => {} });
    assert.equal(cfg.heartbeat_interval, 15000);
    assert.equal(cfg.max_concurrent_requests, 100);
    // configurable keys in the same file still apply
    assert.equal(cfg.server_url, 'ws://example.test/ws');
  } finally {
    removeTempConfig(file);
  }
});

test('an ignored setting is reported instead of dropped silently', () => {
  const warnings: string[] = [];
  loadClientConfig({
    env: { HEARTBEAT_INTERVAL: '1000', TLS_REJECT_UNAUTHORIZED: 'true' },
    warn: (message: string) => warnings.push(message),
  });
  assert.equal(warnings.length, 2, warnings.join(' | '));
  assert.ok(warnings.every((w: string) => w.includes('不再可配置')));
  assert.ok(warnings.some((w: string) => w.includes('HEARTBEAT_INTERVAL')));
});

test('configurable keys still come from the file and the environment', () => {
  const file = writeTempConfig(['region: from-file', 'tags: from-file', ''].join('\n'));
  try {
    const cfg = loadClientConfig({
      filePaths: [file],
      env: { REGION: 'from-env' },
      warn: () => {},
    });
    assert.equal(cfg.region, 'from-env', 'environment must win over the file');
    assert.equal(cfg.tags, 'from-file', 'file value must apply when the env var is unset');
  } finally {
    removeTempConfig(file);
  }
});

test('the generated example documents only the configurable keys', () => {
  const yaml = renderExampleYaml();
  for (const key of CONFIGURABLE) assert.ok(yaml.includes(`${key}:`), `${key} must be documented`);
  for (const it of FIXED) {
    assert.ok(!yaml.includes(`${it.key}:`), `${it.key} must not be documented as configurable`);
  }
});
