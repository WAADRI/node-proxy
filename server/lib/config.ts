// =============================================================================
// Config - Configuration loader (YAML + env vars + CLI args)
// Migrated to TypeScript (issue #42, Phase 2). Written as a plain ESM module:
// Node >= 23.6 type-strips it at runtime and the caller can
// `require('./lib/config.ts')` (sync require of ESM).
// =============================================================================

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { randomBytes } from 'crypto';

// --- Typed configuration shape -------------------------------------------------
// Core sections below mirror DEFAULTS exactly. Additional runtime sections the
// server reads from config.yaml (routing / cache / acme / ...) are declared as
// optional so future TypeScript consumers are typed, and are tightened as those
// modules migrate.

export interface ServerSection {
  host: string;
  web_port: number;
  http_proxy_port: number;
  socks5_port: number;
  ipv6_only?: boolean;
}

export interface TlsSection {
  enabled: boolean;
  cert: string;
  key: string;
  auto_generate: boolean;
  cert_dir?: string;
}

export interface ProxyAuthSection {
  enabled: boolean;
  username: string;
  password: string;
}

export interface WebAuthSection {
  enabled: boolean;
  username: string;
  password: string;
  jwt_secret: string;
}

export interface WebUserEntry {
  username: string;
  password_hash?: string;
  role?: 'admin' | 'operator' | 'viewer';
  enabled?: boolean;
  created_at?: number;
}

export interface AuthSection {
  token: string;
  proxy: ProxyAuthSection;
  web: WebAuthSection;
  users?: WebUserEntry[] | null;
}

export interface LoggingSection {
  level: string;
  file: string;
  max_size: number;
  max_files: number;
  pretty: boolean;
}

export interface HealthCheckSection {
  ping_interval: number;
  ping_timeout: number;
  max_failures: number;
}

export interface ClientSection {
  request_timeout: number;
  tunnel_timeout: number;
  tunnel_idle_timeout: number;
  max_concurrent: number;
}

export interface RoutingSection {
  strategy: string;
}

export interface CircuitBreakerSection {
  error_threshold?: number;
  window_ms?: number;
  recovery_timeout_ms?: number;
  half_open_max_attempts?: number;
}

export interface BandwidthSection {
  enabled: boolean;
  default_rate?: number;
  default_burst?: number;
  global_rate?: number;
  global_burst?: number;
}

export interface MetricsSection {
  enabled: boolean;
}

export interface CacheSection {
  enabled?: boolean;
  default_ttl?: number;
  max_size?: number;
}

export interface AcmeSection {
  enabled?: boolean;
  email?: string;
  staging?: boolean;
  domains?: string[];
}

export interface StorageSection {
  path?: string;
}

export interface ServerConfig {
  server: ServerSection;
  tls: TlsSection;
  auth: AuthSection;
  logging: LoggingSection;
  health_check: HealthCheckSection;
  client: ClientSection;
  // Optional runtime sections loaded from config.yaml / config.local.yaml:
  routing?: RoutingSection;
  circuit_breaker?: CircuitBreakerSection;
  bandwidth?: BandwidthSection;
  metrics?: MetricsSection;
  cache?: CacheSection;
  acme?: AcmeSection;
  storage?: StorageSection;
  domain_rules?: unknown;
  plugins?: unknown;
  acl?: unknown;
  audit?: unknown;
  update?: unknown;
  mux?: unknown;
}

export const DEFAULTS: ServerConfig = {
  server: {
    host: '0.0.0.0',
    web_port: 3000,
    http_proxy_port: 8080,
    socks5_port: 1080,
  },
  tls: {
    enabled: false,
    cert: '',
    key: '',
    auto_generate: true,
  },
  auth: {
    token: 'node-proxy-default-token',
    proxy: {
      enabled: false,
      username: 'proxy',
      password: 'proxy-pass',
    },
    web: {
      enabled: true,
      username: 'admin',
      password: 'admin123',
      jwt_secret: '',
    },
  },
  logging: {
    level: 'info',
    file: '',
    max_size: 10485760,
    max_files: 5,
    pretty: false,
  },
  health_check: {
    ping_interval: 10000,
    ping_timeout: 5000,
    max_failures: 3,
  },
  client: {
    request_timeout: 30000,
    tunnel_timeout: 15000,
    tunnel_idle_timeout: 60000,
    max_concurrent: 100,
  },
};

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge plain objects; primitives/arrays from later sources win.
// Internal-only helper operating on record shapes (typed entry point is loadConfig).
function deepMergeRecord(target: Record<string, unknown>, ...sources: unknown[]): Record<string, unknown> {
  for (const source of sources) {
    if (!isPlainRecord(source)) continue;
    for (const key of Object.keys(source)) {
      const val = source[key];
      if (isPlainRecord(val)) {
        const child = isPlainRecord(target[key]) ? (target[key] as Record<string, unknown>) : {};
        target[key] = deepMergeRecord(child, val);
      } else {
        target[key] = val;
      }
    }
  }
  return target;
}

// Write value at a dotted path (from env var / CLI keys) into a nested record.
// Path segments come from static configuration keys (NP_* env vars, --a-b CLI
// args), not from request/user input.
function applyPath(root: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    const next = current[seg];
    if (!isPlainRecord(next)) current[seg] = {};
    current = current[seg] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function mapEnvToConfig(env: Record<string, string | undefined>, prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(env)) {
    const raw = env[key];
    if (!key.startsWith(prefix) || raw === undefined) continue;
    const parts = key.slice(prefix.length).toLowerCase().split('_');
    let val: unknown = raw;
    if (raw === 'true') val = true;
    else if (raw === 'false') val = false;
    else if (/^\d+$/.test(raw)) val = parseInt(raw, 10);
    applyPath(result, parts, val);
  }
  return result;
}

function findConfigFile(): string | null {
  const searchPaths: (string | undefined)[] = [
    process.env.CONFIG_PATH,
    path.join(process.cwd(), 'config.yaml'),
    path.join(process.cwd(), 'config.yml'),
  ];
  for (const p of searchPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function loadYamlConfig(filePath: string): unknown {
  try {
    const doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
    return doc || {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load config file ${filePath}: ${msg}`);
    return {};
  }
}

interface CliArg {
  key: string;
  value: string | boolean;
}

function parseCliArgs(argv: string[]): CliArg[] {
  const args: CliArg[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      const val = next !== undefined && !next.startsWith('--') ? next : true;
      if (val !== true) i++;
      args.push({ key, value: val });
    }
  }
  return args;
}

export function loadConfig(): ServerConfig {
  // Start from a deep copy of defaults
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as ServerConfig;
  const target = config as unknown as Record<string, unknown>;

  // 1) Main YAML file
  const configFile = findConfigFile();
  if (configFile) {
    deepMergeRecord(target, loadYamlConfig(configFile));

    // 2) Optional per-host overlay next to the main config (config.local.yaml).
    // Kept out of git so `git pull` never clobbers production-only values.
    const localFile = configFile.replace(/\.ya?ml$/i, '.local.yaml');
    if (localFile !== configFile && fs.existsSync(localFile)) {
      deepMergeRecord(target, loadYamlConfig(localFile));
    }
  }

  // 3) Environment variables (NP_ prefix)
  deepMergeRecord(target, mapEnvToConfig(process.env, 'NP_'));

  // 4) CLI args (--a-b value)
  const cliMapped: Record<string, unknown> = {};
  for (const { key, value } of parseCliArgs(process.argv.slice(2))) {
    applyPath(cliMapped, key.split('_'), value);
  }
  deepMergeRecord(target, cliMapped);

  // 5) Generate JWT secret if not set
  if (!config.auth.web.jwt_secret) {
    config.auth.web.jwt_secret = randomBytes(32).toString('hex');
  }

  return config;
}

