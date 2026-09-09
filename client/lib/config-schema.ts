// =============================================================================
// Client configuration schema - single source of truth for defaults, env
// mapping, the generated config.yaml.example and the interactive setup wizard
// (issues #40 / #41).
// =============================================================================
// Migrated to TypeScript (issue #42, Phase 2). CJS-style module: keeps
// require()/module.exports so Node type-strips it in place and the runtime
// behavior is unchanged.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

import type * as NodeFs from 'fs';

const fs: typeof NodeFs = require('fs');

type ConfigScalar = string | number | boolean;

interface SchemaEntry {
  key: string;
  env: string[];
  type: 'string' | 'number' | 'boolean';
  default: ConfigScalar;
  desc: string;
  example?: string;
  secret?: boolean;
}

type ConfigValues = Record<string, ConfigScalar>;

const SCHEMA: SchemaEntry[] = [
  {
    key: 'server_url',
    env: ['SERVER_URL'],
    type: 'string',
    default: 'ws://127.0.0.1:3000/ws',
    desc: '代理服务器 WebSocket 地址',
    example: 'ws://1.2.3.4:3000/ws',
  },
  {
    key: 'auth_token',
    env: ['AUTH_TOKEN'],
    type: 'string',
    default: 'node-proxy-default-token',
    desc: '认证令牌（须与服务端一致，默认值不安全，生产必改）',
    example: 'my-secret-token',
    secret: true,
  },
  // issue #53: node identity (region / tags) and tuning knobs are no longer
  // passed through environment variables. Only the endpoint (SERVER_URL) and
  // the auth secret (AUTH_TOKEN) honor env overrides; everything below is
  // config-file only. Region/tags are managed on the server panel now.
  {
    key: 'reconnect_delay',
    env: [],
    type: 'number',
    default: 3000,
    desc: '断线重连初始延迟（毫秒）',
  },
  {
    key: 'max_reconnect_delay',
    env: [],
    type: 'number',
    default: 30000,
    desc: '断线重连最大延迟（毫秒）',
  },
  {
    key: 'reconnect_jitter',
    env: [],
    type: 'number',
    default: 1000,
    desc: '重连延迟随机抖动（毫秒）',
  },
  {
    key: 'heartbeat_interval',
    env: [],
    type: 'number',
    default: 15000,
    desc: '心跳间隔（毫秒）',
  },
  {
    key: 'request_timeout',
    env: [],
    type: 'number',
    default: 30000,
    desc: 'HTTP 请求超时（毫秒）',
  },
  {
    key: 'tunnel_timeout',
    env: [],
    type: 'number',
    default: 30000,
    desc: 'TCP 隧道建连超时（毫秒）',
  },
  {
    key: 'max_concurrent_requests',
    env: [],
    type: 'number',
    default: 100,
    desc: '最大并发请求数',
  },
  {
    key: 'tls_reject_unauthorized',
    env: [],
    type: 'boolean',
    default: false,
    desc: '是否校验证书（自签证书场景设 false）',
  },
];

function defaults(): ConfigValues {
  const out: ConfigValues = {};
  for (const it of SCHEMA) out[it.key] = it.default;
  return out;
}

function coerce(type: SchemaEntry['type'], raw: unknown): ConfigScalar {
  if (type === 'number') return parseInt(raw as string, 10);
  if (type === 'boolean') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  return String(raw);
}

interface LoadClientConfigOptions {
  filePaths?: string[];
  env?: Record<string, string | undefined>;
}

function loadClientConfig({ filePaths = [], env = process.env }: LoadClientConfigOptions = {}): ConfigValues {
  const config = defaults();

  // 1) yaml config file (first existing path wins)
  const yaml = require('js-yaml');
  for (const cp of filePaths) {
    if (cp && fs.existsSync(cp)) {
      try {
        const doc = yaml.load(fs.readFileSync(cp, 'utf8')) as Record<string, unknown> | null | undefined;
        if (doc && typeof doc === 'object') {
          for (const it of SCHEMA) {
            if (doc[it.key] !== undefined && doc[it.key] !== null) {
              config[it.key] = coerce(it.type, doc[it.key]);
            }
          }
        }
      } catch (_) {}
      break;
    }
  }

  // 2) environment overrides
  for (const it of SCHEMA) {
    for (const envKey of it.env) {
      if (env[envKey] !== undefined) {
        config[it.key] = coerce(it.type, env[envKey]);
        break;
      }
    }
  }

  return config;
}

// Render a documented config.yaml.example from the schema.
function renderExampleYaml(): string {
  const lines: string[] = [
    '# =============================================================================',
    '# Node-Proxy Client - config.yaml.example',
    '# 本文件由 client/lib/config-schema.js 自动生成，请勿手改。',
    '# 部署用法：复制为 config.yaml 后按需修改；环境变量会覆盖同名项。',
    '# =============================================================================',
    '',
  ];
  for (const it of SCHEMA) {
    lines.push(`# ${it.desc}`);
    lines.push(`# 默认: ${JSON.stringify(it.default)}${it.secret ? '（生产环境必改）' : ''}`);
    if (it.env && it.env.length) lines.push(`# 环境变量: ${it.env.join(' / ')}`);
    const val = it.example !== undefined ? it.example : it.default;
    lines.push(`${it.key}: ${typeof val === 'string' ? (val || "''") : val}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { SCHEMA, defaults, loadClientConfig, renderExampleYaml };
