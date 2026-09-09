#!/usr/bin/env node
// =============================================================================
// Node-Proxy Server - interactive setup wizard (issue #41)
// Asks the security-relevant settings and writes them to config.local.yaml
// (an untracked overlay that survives `git pull`). Restart the server after.
// =============================================================================
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose.
// =============================================================================
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

import type { Readable, Writable } from 'stream';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const yaml = require('js-yaml');

const rl = readline.createInterface({ input: process.stdin as Readable, output: process.stdout as Writable });
const q = (prompt: string): Promise<string> => new Promise((res) => rl.question(prompt, res));

const rnd = (len: number): string => crypto.randomBytes(len).toString('base64url').slice(0, len);

async function main(): Promise<void> {
  console.log('=== Node-Proxy Server 配置向导 ===');
  console.log('（直接回车使用默认值；生成的覆盖写入 config.local.yaml，不修改 config.yaml）\n');

  const token = await q(`节点认证令牌 (auth.token, 回车生成随机): `);
  const authToken = token.trim() || rnd(32);

  const proxyAuth = (await q('启用代理用户密码认证? (y/N): ')).trim().toLowerCase();
  let proxy: { enabled: boolean; username?: string; password?: string } | null = null;
  if (proxyAuth === 'y' || proxyAuth === 'yes') {
    const user = (await q(`  代理用户名 (默认 proxy): `)).trim() || 'proxy';
    const pass = (await q('  代理密码 (回车生成随机): ')).trim() || rnd(16);
    proxy = { enabled: true, username: user, password: pass };
  }

  const webUser = (await q(`Web 面板管理员用户名 (默认 admin): `)).trim() || 'admin';
  const webPass = (await q('Web 面板管理员密码 (回车生成随机): ')).trim() || rnd(16);

  const overlay = {
    auth: {
      token: authToken,
      ...(proxy ? { proxy } : { proxy: { enabled: false } }),
      web: { username: webUser, password: webPass },
    },
  };

  const target = path.join(process.cwd(), 'config.local.yaml');
  const mainCfg = path.join(process.cwd(), 'config.yaml');
  if (!fs.existsSync(mainCfg)) {
    console.log('\n警告: 当前目录未找到 config.yaml，请 cd 到 server 目录后重跑。');
    process.exit(1);
  }
  fs.writeFileSync(target, yaml.dump(overlay, { noRefs: true }));
  console.log(`\n已写入 ${target}，内容摘要：`);
  console.log(`  auth.token        : ${authToken}`);
  if (proxy && proxy.enabled) console.log(`  auth.proxy        : 启用  ${proxy.username} / ${proxy.password}`);
  else console.log('  auth.proxy        : 未启用（如需对外开放请启用）');
  console.log(`  auth.web          : ${webUser} / ${webPass}`);
  console.log('\n重启服务端后生效。请妥善保存以上凭据。');
  process.exit(0);
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });