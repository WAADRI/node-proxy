// =============================================================================
// Export the runtime OpenAPI spec (server/lib/swagger.ts) to generated.json so
// redocly can lint it. Single source of truth stays swaggerSpec in swagger.ts.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const { swaggerSpec } = require('../lib/swagger.ts');

// Deep-copy and auto-fill operationIds (e.g. GET /client/{id}/tags ->
// getClientIdTags) so redocly lints clean without hand-maintaining 50+ ids.
const spec = JSON.parse(JSON.stringify(swaggerSpec));
for (const [p, item] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    if (!op.operationId) {
      const frag = p
        .replace(/[{}]/g, '')
        .split('/')
        .filter(Boolean)
        .map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1)))
        .join('');
      op.operationId = method + frag.charAt(0).toUpperCase() + frag.slice(1);
    }
  }
}

const out = path.join(__dirname, '..', 'openapi', 'generated.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(spec, null, 2));
console.log(`exported to ${path.relative(process.cwd(), out)}`);
