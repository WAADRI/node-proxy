// =============================================================================
// OpenAPI consistency check (issue #42, Phase 1)
// Ensures the runtime spec in server/lib/swagger.js covers every JSON API route
// the server actually registers ("no invisible endpoints").
//
//  * scans server source files for express route registrations
//  * normalizes: strips the /api /api/v1 mount prefixes, :param -> {param}
//  * compares (method, path) sets against swaggerSpec.paths
//  * exits non-zero when an implemented route is missing from the spec
//
// Non-JSON/page/static endpoints are excluded via EXCLUDE (paths under /login
// HTML page, /app assets, swagger meta endpoints, prometheus /metrics which is
// documented separately as text/plain under the root server).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['server/lib/web-server.ts'];

// (method, path) pairs that are pages/static/meta, not JSON API surface.
const EXCLUDE = [
  ['GET', '/'],
  ['GET', '/login'],
  ['GET', '/app'],
  ['GET', '/app/*'],
  ['USE', '/app/assets'],
  ['USE', '/'], // router mounts (app.use('/api'...)), not endpoints
  ['GET', '/api/swagger.json'],
  ['GET', '/api/docs'],
];

const MOUNT_PREFIXES = ['/api/v1', '/api'];

function collectRoutes(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = /\b(?:app|api|router)\.(get|post|put|patch|delete|all|use)\(\s*(['"`])(\/[^'"`]*)\2/g;
  const routes = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    let p = m[3];
    for (const prefix of MOUNT_PREFIXES) {
      if (p === prefix || p.startsWith(prefix + '/')) {
        p = p.slice(prefix.length) || '/';
        break;
      }
    }
    p = p.replace(/:[A-Za-z0-9_]+/g, (x) => `{${x.slice(1)}}`);
    if (EXCLUDE.some(([em, ep]) => em === method && (ep === p || ep.endsWith('*') && p.startsWith(ep.slice(0, -1))))) continue;
    routes.add(`${method} ${p}`);
  }
  return routes;
}

function collectSpec() {
  const { swaggerSpec } = require('../lib/swagger');
  const out = new Set();
  for (const [p, item] of Object.entries(swaggerSpec.paths || {})) {
    for (const method of Object.keys(item)) {
      out.add(`${method.toUpperCase()} ${p}`);
    }
  }
  return out;
}

function main() {
  const impl = new Set();
  for (const f of SOURCES) for (const r of collectRoutes(f)) impl.add(r);
  const spec = collectSpec();

  const missing = [...impl].filter((r) => !spec.has(r)).sort();
  const orphan = [...spec].filter((r) => !impl.has(r)).sort();

  console.log(`实现路由: ${impl.size} | 文档端点: ${spec.size}`);
  if (missing.length) {
    console.log('\n❌ 实现中存在、OpenAPI 文档缺失（隐形接口，需补进 server/lib/swagger.js）:');
    for (const r of missing) console.log(`   ${r}`);
  }
  if (orphan.length) {
    console.log('\n⚠️  文档中有、实现未注册（死文档，建议清理）:');
    for (const r of orphan) console.log(`   ${r}`);
  }
  console.log(missing.length ? `\n结果: FAIL (${missing.length} 缺失)` : '\n结果: PASS（无隐形接口）');
  process.exit(missing.length ? 1 : 0);
}

main();
