// =============================================================================
// Example Plugin - Logs all proxy requests with time, source IP and domain
// =============================================================================
// Migrated to TypeScript (issue #42, Phase 2). CJS-style: values are exported
// via module.exports only; the type-only export below makes TypeScript treat
// this as a module (eliminating global-scope collisions).
// =============================================================================
'use strict';

export type {};

const meta = {
  name: 'request-logger',
  version: '1.1.0',
  description: 'Logs all proxy requests with timestamp, client IP and domain',
};

// Called when the plugin is loaded
function init(_pluginManager: unknown): void {
  // Register any resources here
}

function fmtTime(ts: number | string | undefined | null): string {
  try {
    return new Date(ts || Date.now()).toISOString();
  } catch (_) {
    return String(ts || '');
  }
}

interface RequestContext {
  method?: string;
  url?: string;
  clientId?: string;
  ip?: string;
  timestamp?: number | string;
}

interface ResponseContext {
  statusCode?: number;
  duration?: number;
  url?: string;
  ip?: string;
  timestamp?: number | string;
}

// Called for every HTTP request that goes through the proxy
function onRequest(context: RequestContext): void {
  const { method, url, clientId, ip, timestamp } = context;
  console.log(
    `[plugin:request-logger] ${fmtTime(timestamp)} ${ip || '-'} ${method} ${url} -> client ${clientId ? clientId.substring(0, 8) : 'none'}`
  );
}

// Called for every HTTP response received from the target
function onResponse(context: ResponseContext): void {
  const { statusCode, duration, url, ip, timestamp } = context;
  console.log(
    `[plugin:request-logger] ${fmtTime(timestamp)} ${ip || '-'} ${url} -> ${statusCode} (${duration || 0}ms)`
  );
}

// Cleanup when plugin is uninstalled
function cleanup(): void {
  console.log('[plugin:request-logger] Cleaned up');
}

module.exports = { meta, init, onRequest, onResponse, cleanup };