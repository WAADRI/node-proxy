// =============================================================================
// Generate config.yaml.example for server AND client from code defaults
// (issue #41). Run: node server/scripts/gen-config-example.js
// A CI workflow auto-runs this on push and commits any resulting changes.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..', '..');

// --- server ------------------------------------------------------------------
const { DEFAULTS } = require('../lib/config');
const serverHead = [
  '# =============================================================================',
  '# Node-Proxy Server - config.yaml.example',
  '# 本文件由 server/lib/config.js 的 DEFAULTS 自动生成 —— 请勿手改。',
  '# 部署用法：复制为 config.yaml 后按需修改；NP_* 环境变量与 config.local.yaml 可覆盖。',
  '# 变更源头见 server/lib/config.js；CI（同步配置示例）会自动同步本文件。',
  '# =============================================================================',
  '',
].join('\n');
fs.writeFileSync(path.join(root, 'server', 'config.yaml.example'), serverHead + yaml.dump(DEFAULTS, { noRefs: true }));

// --- client ------------------------------------------------------------------
const { renderExampleYaml } = require('../../client/lib/config-schema');
fs.writeFileSync(path.join(root, 'client', 'config.yaml.example'), renderExampleYaml());

console.log('config.yaml.example regenerated (server + client)');
