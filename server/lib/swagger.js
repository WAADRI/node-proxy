// =============================================================================
// Swagger - OpenAPI documentation for the proxy API
// =============================================================================
'use strict';

const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Node-Proxy API',
    description: 'Distributed IP proxy management API. Supports multi-user RBAC, domain routing rules, request caching, and plugin system.',
    version: '3.0.0',
    contact: { name: 'Node-Proxy' },
  },
  servers: [
    { url: '/api/v1', description: 'v1 API' },
    { url: '/api', description: 'Legacy API' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      CookieAuth: { type: 'apiKey', in: 'cookie', name: 'token' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
      Status: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Online clients count' },
          clients: { type: 'array', items: { $ref: '#/components/schemas/Client' } },
          server: { $ref: '#/components/schemas/ServerStats' },
          routing: { $ref: '#/components/schemas/Routing' },
          tags: { type: 'array', items: { type: 'string' } },
          circuitBreaker: { type: 'object' },
          bandwidth: { type: 'object' },
        },
      },
      Client: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          info: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
          connectedAt: { type: 'integer' },
          lastSeen: { type: 'integer' },
          pendingRequestsCount: { type: 'integer' },
          pendingTunnelsCount: { type: 'integer' },
          avgResponseTime: { type: 'integer' },
          circuitBreaker: { type: 'object', properties: { state: { type: 'string', enum: ['closed', 'open', 'half_open'] } } },
        },
      },
      ServerStats: {
        type: 'object',
        properties: {
          uptime: { type: 'integer' },
          totalRequests: { type: 'integer' },
          totalTunnels: { type: 'integer' },
          totalBytesSent: { type: 'integer' },
          totalBytesReceived: { type: 'integer' },
          failedRequests: { type: 'integer' },
          pendingRequests: { type: 'integer' },
        },
      },
      Routing: {
        type: 'object',
        properties: {
          strategy: { type: 'string', enum: ['random', 'least-loaded', 'fastest-response', 'weighted'] },
          availableStrategies: { type: 'array', items: { type: 'string' } },
        },
      },
      DomainRule: {
        type: 'object',
        required: ['pattern', 'tag'],
        properties: {
          pattern: { type: 'string', example: '*.example.com', description: 'Wildcard domain pattern' },
          tag: { type: 'string', example: 'region:cn', description: 'Target client tag' },
          priority: { type: 'integer', default: 0, description: 'Rule priority (higher wins)' },
        },
      },
      User: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
          enabled: { type: 'boolean' },
          createdAt: { type: 'integer' },
        },
      },
      Plugin: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          version: { type: 'string' },
          description: { type: 'string' },
          hooks: { type: 'array', items: { type: 'string' } },
        },
      },
      CacheStats: {
        type: 'object',
        properties: {
          size: { type: 'integer' },
          pending: { type: 'integer' },
          totalHits: { type: 'integer' },
          expired: { type: 'integer' },
          enabled: { type: 'boolean' },
          defaultTTL: { type: 'integer' },
          maxSize: { type: 'integer' },
        },
      },
    },
  },
  paths: {
    '/status': {
      get: {
        tags: ['Status'],
        summary: 'Get server status and client list',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        responses: { '200': { description: 'Server status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Status' } } } } },
      },
    },
    '/config': {
      get: {
        tags: ['Config'],
        summary: 'Get safe server configuration',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Server configuration' } },
      },
    },
    '/routing/strategy': {
      post: {
        tags: ['Routing'],
        summary: 'Change routing strategy',
        security: [{ BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { strategy: { type: 'string', enum: ['random', 'least-loaded', 'fastest-response', 'weighted'] } } } } } },
        responses: { '200': { description: 'Strategy changed' } },
      },
    },
    '/tags': {
      get: {
        tags: ['Clients'],
        summary: 'List all client tags',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Tags list' } },
      },
    },
    '/client/{id}/tags': {
      post: {
        tags: ['Clients'],
        summary: 'Update client tags',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } } } },
        responses: { '200': { description: 'Tags updated' } },
      },
    },
    '/client/{id}/weight': {
      post: {
        tags: ['Clients'],
        summary: 'Set client weight for weighted routing',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { weight: { type: 'number', minimum: 1 } } } } } },
        responses: { '200': { description: 'Weight updated' } },
      },
    },
    '/client/{id}/bandwidth': {
      post: {
        tags: ['Clients'],
        summary: 'Set client bandwidth limit',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { rate: { type: 'integer', minimum: 1024 } } } } } },
        responses: { '200': { description: 'Bandwidth limit updated' } },
      },
    },
    '/client/{id}/circuit-breaker/reset': {
      post: {
        tags: ['Clients'],
        summary: 'Reset circuit breaker for a client',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Circuit breaker reset' } },
      },
    },
    '/client/{id}/kick': {
      post: {
        tags: ['Clients'],
        summary: 'Disconnect a client',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Client kicked' } },
      },
    },
    '/client/{id}/events': {
      get: {
        tags: ['Clients'],
        summary: 'Get client event history',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: { '200': { description: 'Client events' } },
      },
    },
    '/client/{id}/traffic': {
      get: {
        tags: ['Clients'],
        summary: 'Get client traffic statistics',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'since', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Traffic stats' } },
      },
    },
    '/circuit-breaker/status': {
      get: {
        tags: ['Circuit Breaker'],
        summary: 'Get circuit breaker status for all clients',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Circuit breaker statuses' } },
      },
    },
    '/bandwidth/stats': {
      get: {
        tags: ['Bandwidth'],
        summary: 'Get bandwidth limiter statistics',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Bandwidth stats' } },
      },
    },
    '/broadcast': {
      post: {
        tags: ['Admin'],
        summary: 'Broadcast message to all clients',
        security: [{ BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' } } } } } },
        responses: { '200': { description: 'Broadcast sent' } },
      },
    },
    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List all users',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Users list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } },
      },
      post: {
        tags: ['Users'],
        summary: 'Create a new user',
        security: [{ BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username', 'password', 'role'], properties: { username: { type: 'string' }, password: { type: 'string' }, role: { type: 'string', enum: ['admin', 'operator', 'viewer'] } } } } } },
        responses: { '200': { description: 'User created' } },
      },
    },
    '/users/{username}': {
      delete: {
        tags: ['Users'],
        summary: 'Delete a user',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'username', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'User deleted' } },
      },
      patch: {
        tags: ['Users'],
        summary: 'Modify a user',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'username', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string' }, role: { type: 'string', enum: ['admin', 'operator', 'viewer'] }, enabled: { type: 'boolean' } } } } } },
        responses: { '200': { description: 'User modified' } },
      },
    },
    '/domain-rules': {
      get: {
        tags: ['Domain Rules'],
        summary: 'List all domain routing rules',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Domain rules', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DomainRule' } } } } } },
      },
      post: {
        tags: ['Domain Rules'],
        summary: 'Add a domain routing rule',
        security: [{ BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DomainRule' } } } },
        responses: { '200': { description: 'Rule added' } },
      },
      delete: {
        tags: ['Domain Rules'],
        summary: 'Remove a domain routing rule',
        security: [{ BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { pattern: { type: 'string' } } } } } },
        responses: { '200': { description: 'Rule removed' } },
      },
    },
    '/cache/stats': {
      get: {
        tags: ['Cache'],
        summary: 'Get cache statistics',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Cache stats', content: { 'application/json': { schema: { $ref: '#/components/schemas/CacheStats' } } } } },
      },
    },
    '/cache/clear': {
      post: {
        tags: ['Cache'],
        summary: 'Clear the request cache',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Cache cleared' } },
      },
    },
    '/plugins': {
      get: {
        tags: ['Plugins'],
        summary: 'List installed plugins',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Plugin list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Plugin' } } } } } },
      },
    },
    '/plugins/{name}/enable': {
      post: {
        tags: ['Plugins'],
        summary: 'Enable a plugin',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Plugin enabled' } },
      },
    },
    '/plugins/{name}/disable': {
      post: {
        tags: ['Plugins'],
        summary: 'Disable a plugin',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Plugin disabled' } },
      },
    },
    '/plugins/{name}/reload': {
      post: {
        tags: ['Plugins'],
        summary: 'Reload a plugin',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Plugin reloaded' } },
      },
    },
    '/plugins/{name}': {
      delete: {
        tags: ['Plugins'],
        summary: 'Uninstall a plugin',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Plugin uninstalled' } },
      },
    },
    '/acl/rules': {
      get: {
        tags: ['ACL'],
        summary: 'List all ACL rules',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'ACL rules list' } },
      },
      post: {
        tags: ['ACL'],
        summary: 'Add an ACL rule',
        security: [{ BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { action: { type: 'string', enum: ['allow', 'deny'] }, priority: { type: 'integer' }, description: { type: 'string' }, match: { type: 'object' } } } } } },
        responses: { '200': { description: 'Rule added' } },
      },
    },
    '/acl/rules/{ruleId}': {
      delete: {
        tags: ['ACL'],
        summary: 'Remove an ACL rule',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Rule removed' } },
      },
    },
    '/acl/stats': {
      get: {
        tags: ['ACL'],
        summary: 'Get ACL statistics',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'ACL stats' } },
      },
    },
    '/audit/query': {
      get: {
        tags: ['Audit'],
        summary: 'Query audit log entries',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'clientId', in: 'query', schema: { type: 'string' } },
          { name: 'username', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Audit log entries' } },
      },
    },
    '/audit/stats': {
      get: {
        tags: ['Audit'],
        summary: 'Get audit log statistics',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Audit stats' } },
      },
    },
    '/update/status': {
      get: {
        tags: ['Update'],
        summary: 'Get auto-update status',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Update status' } },
      },
    },
    '/update/check': {
      post: {
        tags: ['Update'],
        summary: 'Trigger update check',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Check triggered' } },
      },
    },
    '/mux/stats': {
      get: {
        tags: ['Mux'],
        summary: 'Get stream multiplexer statistics for all clients',
        security: [{ BearerAuth: [] }],
        responses: { '200': { description: 'Mux stats per client' } },
      },
    },
  },
};

function setupSwagger(app) {
  // Serve swagger.json
  app.get('/api/swagger.json', (req, res) => {
    res.json(swaggerSpec);
  });

  // Serve Swagger UI
  app.get('/api/docs', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Node-Proxy API Docs</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.min.js"></script>
  <script>
    SwaggerUIBundle({ url: '/api/swagger.json', dom_id: '#swagger-ui', presets: [SwaggerUIBundle.presets.apis], layout: "BaseLayout" });
  </script>
</body>
</html>`);
  });
}

module.exports = { setupSwagger, swaggerSpec };