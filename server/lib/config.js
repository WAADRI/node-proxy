// =============================================================================
// Config - Configuration loader (YAML + env vars + CLI args)
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULTS = {
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
    max_concurrent: 100,
  },
};

function findConfigFile() {
  const searchPaths = [
    process.env.CONFIG_PATH,
    path.join(process.cwd(), 'config.yaml'),
    path.join(process.cwd(), 'config.yml'),
    path.join(__dirname, '..', 'config.yaml'),
    path.join(__dirname, '..', 'config.yml'),
  ];

  for (const p of searchPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function loadYamlConfig(filePath) {
  try {
    const doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
    return doc || {};
  } catch (err) {
    console.error(`Failed to load config file ${filePath}: ${err.message}`);
    return {};
  }
}

function parseCliArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-/g, '_');
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      if (val !== true) i++;
      args[key] = val;
    }
  }
  return args;
}

function deepMerge(target, ...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(source)) {
      const val = source[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        target[key] = deepMerge(target[key] || {}, val);
      } else {
        target[key] = val;
      }
    }
  }
  return target;
}

function mapEnvToConfig(env, prefix) {
  const result = {};
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix)) {
      const configPath = key.slice(prefix.length).toLowerCase().split('_');
      let current = result;
      for (let i = 0; i < configPath.length - 1; i++) {
        if (!current[configPath[i]]) current[configPath[i]] = {};
        current = current[configPath[i]];
      }
      const lastKey = configPath[configPath.length - 1];
      const val = env[key];
      // Try to parse numbers and booleans
      if (val === 'true') current[lastKey] = true;
      else if (val === 'false') current[lastKey] = false;
      else if (/^\d+$/.test(val)) current[lastKey] = parseInt(val, 10);
      else current[lastKey] = val;
    }
  }
  return result;
}

function loadConfig() {
  // Start with defaults
  const config = JSON.parse(JSON.stringify(DEFAULTS));

  // Load from YAML file
  const configFile = findConfigFile();
  if (configFile) {
    const yamlConfig = loadYamlConfig(configFile);
    deepMerge(config, yamlConfig);
  }

  // Load from environment variables (NP_ prefix)
  const envConfig = mapEnvToConfig(process.env, 'NP_');
  deepMerge(config, envConfig);

  // Load from CLI args
  const cliConfig = parseCliArgs();
  // Map CLI args to config structure
  const cliMapped = {};
  for (const [key, val] of Object.entries(cliConfig)) {
    const parts = key.split('_');
    let current = cliMapped;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = val;
  }
  deepMerge(config, cliMapped);

  // Generate JWT secret if not set
  if (!config.auth.web.jwt_secret) {
    const crypto = require('crypto');
    config.auth.web.jwt_secret = crypto.randomBytes(32).toString('hex');
  }

  return config;
}

module.exports = { loadConfig, DEFAULTS };