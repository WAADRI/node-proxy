// =============================================================================
// Example Plugin - Logs all proxy requests with time, source IP and domain
// =============================================================================
'use strict';

const meta = {
  name: 'request-logger',
  version: '1.1.0',
  description: 'Logs all proxy requests with timestamp, client IP and domain',
};

// Called when the plugin is loaded
function init(pluginManager) {
  // Register any resources here
}

function fmtTime(ts) {
  try {
    return new Date(ts || Date.now()).toISOString();
  } catch (_) {
    return String(ts || '');
  }
}

// Called for every HTTP request that goes through the proxy
function onRequest(context) {
  const { method, url, clientId, ip, timestamp } = context;
  console.log(
    `[plugin:request-logger] ${fmtTime(timestamp)} ${ip || '-'} ${method} ${url} -> client ${clientId ? clientId.substring(0, 8) : 'none'}`
  );
}

// Called for every HTTP response received from the target
function onResponse(context) {
  const { statusCode, duration, url, ip, timestamp } = context;
  console.log(
    `[plugin:request-logger] ${fmtTime(timestamp)} ${ip || '-'} ${url} -> ${statusCode} (${duration || 0}ms)`
  );
}

// Cleanup when plugin is uninstalled
function cleanup() {
  console.log('[plugin:request-logger] Cleaned up');
}

module.exports = { meta, init, onRequest, onResponse, cleanup };
