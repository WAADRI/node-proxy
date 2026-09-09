#!/usr/bin/env node
// =============================================================================
// Node-Proxy Client - interactive setup wizard (issue #41)
// Writes client/config.yaml (or CONFIG_PATH) plus an optional persistent
// client id. Restart the client afterwards.
// =============================================================================
// Migrated to TypeScript (issue #42, Phase 2). CJS-style: the type-only export
// below makes TypeScript treat this as a module (eliminating global-scope
// collisions).
// =============================================================================
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
export type {};

import type { Readable, Writable } from 'stream';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const yaml = require('js-yaml');

const rl = readline.createInterface({ input: process.stdin as Readable, output: process.stdout as Writable });
const q = (prompt: string): Promise<string> => new Promise((res) => rl.question(prompt, res));

async function main(): Promise<void> {
  console.log('=== Node-Proxy Client 配置向导 ===\n');

  const serverUrl = (await q('代理服务器地址 (SERVER_URL, e.g. ws://1.2.3.4:3000/ws): ')).trim();
  if (!serverUrl) { console.log('server_url 必填'); process.exit(1); }
  const authToken = (await q('认证令牌 (AUTH_TOKEN): ')).trim();
  if (!authToken) { console.log('auth_token 必填（与服务端一致）'); process.exit(1); }
  const clientId = (await q('节点固定 ID (CLIENT_ID, 可选, 便于面板识别): ')).trim();
  const region = (await q('区域标识 (REGION, 可选): ')).trim();
  const tags = (await q('标签 (TAGS, 逗号分隔, 可选): ')).trim();

  const cfg: Record<string, string> = {
    server_url: serverUrl,
    auth_token: authToken,
  };
  if (region) cfg.region = region;
  if (tags) cfg.tags = tags;

  const target = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.yaml');
  fs.writeFileSync(target, yaml.dump(cfg, { noRefs: true }));
  console.log(`\n已写入 ${target}`);

  if (clientId) {
    const idFile = process.env.CLIENT_ID_FILE || path.join(os.homedir(), '.node-proxy-client-id');
    fs.writeFileSync(idFile, clientId);
    console.log(`节点 ID 已持久化到 ${idFile}`);
  }

  console.log('\n重启客户端后生效。');
  process.exit(0);
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });