// =============================================================================
// Client configuration schema - single source of truth for defaults, env
// mapping, the generated config.yaml.example and the interactive setup wizard
// (issues #40 / #41).
// =============================================================================
'use strict';

const fs = require('fs');

const SCHEMA = [
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
  {
    key: 'reconnect_delay',
    env: ['RECONNECT_DELAY'],
    type: 'number',
    default: 3000,
    desc: '断线重连初始延迟（毫秒）',
  },
  {
    key: 'max_reconnect_delay',
    env: ['MAX_RECONNECT_DELAY'],
    type: 'number',
    default: 30000,
    desc: '断线重连最大延迟（毫秒）',
  },
  {
    key: 'reconnect_jitter',
    env: ['RECONNECT_JITTER'],
    type: 'number',
    default: 1000,
    desc: '重连延迟随机抖动（毫秒）',
  },
  {
    key: 'heartbeat_interval',
    env: ['HEARTBEAT_INTERVAL'],
    type: 'number',
    default: 15000,
    desc: '心跳间隔（毫秒）',
  },
  {
    key: 'request_timeout',
    env: ['REQUEST_TIMEOUT'],
    type: 'number',
    default: 30000,
    desc: 'HTTP 请求超时（毫秒）',
  },
  {
    key: 'tunnel_timeout',
    env: ['TUNNEL_TIMEOUT'],
    type: 'number',
    default: 30000,
    desc: 'TCP 隧道建连超时（毫秒）',
  },
  {
    key: 'max_concurrent_requests',
    env: ['MAX_CONCURRENT_REQUESTS'],
    type: 'number',
    default: 100,
    desc: '最大并发请求数',
  },
  {
    key: 'region',
    env: ['REGION', 'NODE_REGION'],
    type: 'string',
    default: 'unknown',
    desc: '节点区域标识',
    example: 'cn',
  },
  {
    key: 'tags',
    env: ['TAGS'],
    type: 'string',
    default: '',
    desc: '节点标签，逗号分隔',
    example: 'region:cn,isp:unicom',
  },
  {
    key: 'tls_reject_unauthorized',
    env: ['TLS_REJECT_UNAUTHORIZED'],
    type: 'boolean',
    default: false,
    desc: '是否校验证书（自签证书场景设 false）',
  },
];

function defaults() {
  const out = {};
  for (const it of SCHEMA) out[it.key] = it.default;
  return out;
}

function coerce(type, raw) {
  if (type === 'number') return parseInt(raw, 10);
  if (type === 'boolean') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  return String(raw);
}

function loadClientConfig({ filePaths = [], env = process.env } = {}) {
  const config = defaults();

  // 1) yaml config file (first existing path wins)
  const yaml = require('js-yaml');
  for (const cp of filePaths) {
    if (cp && fs.existsSync(cp)) {
      try {
        const doc = yaml.load(fs.readFileSync(cp, 'utf8'));
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
function renderExampleYaml() {
  const lines = [
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
