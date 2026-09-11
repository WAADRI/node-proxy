// =============================================================================
// Client configuration schema - single source of truth for the handful of
// settings a node may configure, plus the internals it may not.
// =============================================================================
// Issue #53 (item 4): a node is configured with its endpoint, its auth
// credential and the region/tags it reports - nothing else. Deployments used to
// carry their own tuning values (heartbeat interval, timeouts, concurrency,
// reconnect backoff), which let two nodes behave differently in ways nobody
// could see from the panel. Those are fixed constants now: they stay in the
// config object so the runtime keeps a single source of values, but neither
// config.yaml nor the environment can change them.
//
// The node UUID is not part of this schema: it comes from CLIENT_ID or
// CLIENT_ID_FILE, and is auto-generated (and persisted) when unset.
//
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

// Settings a node may be configured with (config.yaml, overridden by the
// environment). Everything a node legitimately needs to differ on lives here.
const SCHEMA: SchemaEntry[] = [
  {
    key: 'server_url',
    env: ['SERVER_URL'],
    type: 'string',
    default: 'ws://127.0.0.1:3000/ws',
    desc: '代理服务器 WebSocket 地址（端点）',
    example: 'ws://1.2.3.4:3000/ws',
  },
  {
    key: 'auth_token',
    env: ['AUTH_TOKEN'],
    type: 'string',
    default: 'node-proxy-default-token',
    desc: '鉴权凭据（须与服务端一致，默认值不安全，生产必改）',
    example: 'my-secret-token',
    secret: true,
  },
  // region / tags are node-side defaults only: the panel stays authoritative
  // (a value set there wins), these merely seed what the node reports.
  {
    key: 'region',
    env: ['REGION', 'NODE_REGION'],
    type: 'string',
    default: '',
    desc: '节点区域（可选，面板未设置时显示该值；面板设置后以面板为准）',
    example: 'cn-guangzhou',
  },
  {
    key: 'tags',
    env: ['TAGS'],
    type: 'string',
    default: '',
    desc: '节点标签，逗号分隔（可选，面板未设置时显示该值；面板设置后以面板为准）',
    example: 'cn,premium',
  },
];

// Fixed internals. These are deliberately NOT configurable (issue #53, item 4):
// no config.yaml entry and no environment variable can change them. They are
// still present in the loaded config so the runtime reads them from one place.
// An ignored value is reported on stderr rather than dropped silently - a
// setting that quietly stops taking effect is exactly the failure mode that
// made the old per-node tuning untrustworthy.
const FIXED: SchemaEntry[] = [
  {
    key: 'reconnect_delay',
    env: ['RECONNECT_DELAY'],
    type: 'number',
    default: 3000,
    desc: '断线重连初始延迟（毫秒，固定值）',
  },
  {
    key: 'max_reconnect_delay',
    env: ['MAX_RECONNECT_DELAY'],
    type: 'number',
    default: 30000,
    desc: '断线重连最大延迟（毫秒，固定值）',
  },
  {
    key: 'reconnect_jitter',
    env: ['RECONNECT_JITTER'],
    type: 'number',
    default: 1000,
    desc: '重连延迟随机抖动（毫秒，固定值）',
  },
  {
    key: 'heartbeat_interval',
    env: ['HEARTBEAT_INTERVAL'],
    type: 'number',
    default: 15000,
    desc: '心跳间隔（毫秒，固定值）',
  },
  {
    key: 'request_timeout',
    env: ['REQUEST_TIMEOUT'],
    type: 'number',
    default: 30000,
    desc: 'HTTP 请求超时（毫秒，固定值）',
  },
  {
    key: 'tunnel_timeout',
    env: ['TUNNEL_TIMEOUT'],
    type: 'number',
    default: 30000,
    desc: 'TCP 隧道建连超时（毫秒，固定值）',
  },
  {
    key: 'max_concurrent_requests',
    env: ['MAX_CONCURRENT_REQUESTS'],
    type: 'number',
    default: 100,
    desc: '最大并发请求数（固定值）',
  },
  {
    key: 'tls_reject_unauthorized',
    env: ['TLS_REJECT_UNAUTHORIZED'],
    type: 'boolean',
    default: false,
    desc: '是否校验证书（固定值，自签证书场景保持 false）',
  },
];

function defaults(): ConfigValues {
  const out: ConfigValues = {};
  for (const it of SCHEMA) out[it.key] = it.default;
  for (const it of FIXED) out[it.key] = it.default;
  return out;
}

// Returns null when the raw value must not be applied, so the caller keeps the
// value it already has (the default, or a lower-precedence source). An unset
// variable written as `${VAR:-}` in compose arrives as an empty string:
// coercing that to a number yields NaN, and a NaN delay makes setInterval fire
// continuously - so empty and unparsable values are rejected instead of
// silently poisoning the config.
function coerce(type: SchemaEntry['type'], raw: unknown): ConfigScalar | null {
  if (raw === '' || raw === null || raw === undefined) return null;
  if (type === 'number') {
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    const s = String(raw).toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return null;
  }
  return String(raw);
}

interface LoadClientConfigOptions {
  filePaths?: string[];
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}

// Report a setting that is no longer honoured instead of ignoring it silently:
// an operator who keeps an old compose file or config.yaml needs to know that
// the value stopped applying.
function ignoredHints(
  warn: (message: string) => void,
  sources: { env?: Record<string, string | undefined>; yamlKeys?: Set<string> },
): void {
  const reported = new Set<string>();
  for (const it of FIXED) {
    const fromYaml = sources.yamlKeys ? sources.yamlKeys.has(it.key) : false;
    const envKey = sources.env ? it.env.find((k) => sources.env![k] !== undefined) : undefined;
    if (!fromYaml && !envKey) continue;
    if (reported.has(it.key)) continue;
    reported.add(it.key);
    const where = fromYaml ? 'config.yaml' : `环境变量 ${envKey}`;
    warn(`[config] ${it.key} 已不再可配置（issue #53），来自 ${where} 的值被忽略，使用固定值 ${JSON.stringify(it.default)}`);
  }
}

function loadClientConfig({
  filePaths = [],
  env = process.env,
  warn = (message: string) => console.warn(message),
}: LoadClientConfigOptions = {}): ConfigValues {
  const config = defaults();

  // 1) yaml config file (first existing path wins). Only configurable keys are
  // read; fixed internals in the file are ignored and reported.
  const yaml = require('js-yaml');
  for (const cp of filePaths) {
    if (cp && fs.existsSync(cp)) {
      try {
        const doc = yaml.load(fs.readFileSync(cp, 'utf8')) as Record<string, unknown> | null | undefined;
        if (doc && typeof doc === 'object') {
          for (const it of SCHEMA) {
            if (doc[it.key] !== undefined && doc[it.key] !== null) {
              const v = coerce(it.type, doc[it.key]);
              if (v !== null) config[it.key] = v;
            }
          }
          ignoredHints(warn, { yamlKeys: new Set(Object.keys(doc)) });
        }
      } catch (_) {}
      break;
    }
  }

  // 2) environment overrides (highest precedence; an empty or unparsable value
  // is treated as "not set" so it cannot wipe out the default)
  for (const it of SCHEMA) {
    for (const envKey of it.env) {
      if (env[envKey] === undefined) continue;
      const v = coerce(it.type, env[envKey]);
      if (v === null) continue; // try the next alias, else keep the default
      config[it.key] = v;
      break;
    }
  }
  ignoredHints(warn, { env });

  return config;
}

// Render a documented config.yaml.example from the schema.
function renderExampleYaml(): string {
  const lines: string[] = [
    '# =============================================================================',
    '# Node-Proxy Client - config.yaml.example',
    '# 本文件由 client/lib/config-schema.ts 自动生成，请勿手改。',
    '# 部署用法：复制为 config.yaml 后按需修改。',
    '# 每一项都可用对应环境变量覆盖（环境变量优先级高于本文件）；',
    '# 节点 UUID 走 CLIENT_ID 或 CLIENT_ID_FILE（缺省自动生成并持久化）；',
    '# region / tags 可选：面板没设置时显示这里的值，面板设置后以面板为准。',
    '# =============================================================================',
    '#',
    '# 节点只允许配置以下几项（issue #53 第四条）。心跳、超时、并发、重连退避等',
    '# 行为参数已固定为内置常量，写在本文件或环境变量里都不会生效。',
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

module.exports = { SCHEMA, FIXED, defaults, loadClientConfig, renderExampleYaml };
