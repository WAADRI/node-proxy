// =============================================================================
// Example Plugin - Logs all requests with domain info
// =============================================================================
'use strict';

const meta = {
  name: 'request-logger',
  version: '1.0.0',
  description: 'Logs all proxy requests with domain information',
};

// Called when the plugin is loaded
function init(pluginManager) {
  // Register any resources here
}

// Called for every HTTP request that goes through the proxy
function onRequest(context) {
  const { method, url, headers, clientId } = context;
  console.log(`[plugin:request-logger] ${method} ${url} -> client ${clientId ? clientId.substring(0, 8) : 'none'}`);
}

// Called for every HTTP response received from the target
function onResponse(context) {
  const { statusCode, duration, url } = context;
  console.log(`[plugin:request-logger] ${url} -> ${statusCode} (${duration}ms)`);
}

// Cleanup when plugin is uninstalled
function cleanup() {
  console.log('[plugin:request-logger] Cleaned up');
}

module.exports = { meta, init, onRequest, onResponse, cleanup };