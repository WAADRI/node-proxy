// =============================================================================
// Metrics - Prometheus metrics exporter
// =============================================================================
'use strict';

const promClient = require('prom-client');

class MetricsManager {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.enabled = config.metrics?.enabled !== false;

    if (!this.enabled) {
      this.log.info('Prometheus metrics disabled');
      return;
    }

    // Collect default metrics (memory, event loop, etc.)
    promClient.collectDefaultMetrics({
      prefix: 'node_proxy_',
      gcDurationBuckets: [0.001, 0.01, 0.1, 1, 5, 15],
    });

    // =========================================================================
    // Counters
    // =========================================================================
    this.requestsTotal = new promClient.Counter({
      name: 'node_proxy_requests_total',
      help: 'Total number of proxy requests',
      labelNames: ['type', 'status'],
    });

    this.bytesTotal = new promClient.Counter({
      name: 'node_proxy_bytes_total',
      help: 'Total bytes transferred',
      labelNames: ['direction', 'client_id'],
    });

    this.tunnelTotal = new promClient.Counter({
      name: 'node_proxy_tunnels_total',
      help: 'Total number of TCP tunnels',
      labelNames: ['status'],
    });

    this.errorsTotal = new promClient.Counter({
      name: 'node_proxy_errors_total',
      help: 'Total number of errors',
      labelNames: ['type', 'client_id'],
    });

    // =========================================================================
    // Gauges
    // =========================================================================
    this.activeClients = new promClient.Gauge({
      name: 'node_proxy_active_clients',
      help: 'Number of currently connected clients',
    });

    this.activeRequests = new promClient.Gauge({
      name: 'node_proxy_active_requests',
      help: 'Number of currently pending requests',
    });

    this.activeTunnels = new promClient.Gauge({
      name: 'node_proxy_active_tunnels',
      help: 'Number of currently active tunnels',
    });

    this.clientLoad = new promClient.Gauge({
      name: 'node_proxy_client_load',
      help: 'Per-client load (pending requests)',
      labelNames: ['client_id', 'hostname'],
    });

    this.clientBandwidth = new promClient.Gauge({
      name: 'node_proxy_client_bandwidth_bytes_per_sec',
      help: 'Per-client bandwidth limit',
      labelNames: ['client_id'],
    });

    this.circuitBreakerState = new promClient.Gauge({
      name: 'node_proxy_circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=open, 2=half_open)',
      labelNames: ['client_id'],
    });

    // =========================================================================
    // Histograms
    // =========================================================================
    this.requestDuration = new promClient.Histogram({
      name: 'node_proxy_request_duration_ms',
      help: 'Request duration in milliseconds',
      labelNames: ['type'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 3000, 5000, 10000, 30000],
    });

    this.tunnelDuration = new promClient.Histogram({
      name: 'node_proxy_tunnel_duration_ms',
      help: 'Tunnel duration in milliseconds',
      labelNames: [],
      buckets: [100, 500, 1000, 5000, 15000, 30000, 60000, 300000],
    });

    // =========================================================================
    // Summary
    // =========================================================================
    this.responseSize = new promClient.Summary({
      name: 'node_proxy_response_size_bytes',
      help: 'Response size in bytes',
      percentiles: [0.5, 0.9, 0.99],
      labelNames: ['type'],
    });

    this.log.info('Prometheus metrics enabled');
  }

  // ===========================================================================
  // Record methods
  // ===========================================================================
  recordRequest(type, status, durationMs) {
    if (!this.enabled) return;
    this.requestsTotal.inc({ type, status: String(status) });
    this.requestDuration.observe({ type }, durationMs);
  }

  recordBytes(direction, clientId, bytes) {
    if (!this.enabled) return;
    this.bytesTotal.inc({ direction, client_id: clientId || 'unknown' }, bytes);
    this.responseSize.observe({ type: direction }, bytes);
  }

  recordTunnel(status) {
    if (!this.enabled) return;
    this.tunnelTotal.inc({ status });
  }

  recordError(type, clientId) {
    if (!this.enabled) return;
    this.errorsTotal.inc({ type, client_id: clientId || 'unknown' });
  }

  // ===========================================================================
  // Update gauges (called periodically)
  // ===========================================================================
  updateGauges(clientManager) {
    if (!this.enabled) return;

    const stats = clientManager.getStats();
    this.activeClients.set(stats.total);
    this.activeRequests.set(stats.server.pendingRequests);
    this.activeTunnels.set(stats.server.pendingTunnels);

    // Per-client metrics
    for (const c of stats.clients) {
      this.clientLoad.set({
        client_id: c.id.substring(0, 8),
        hostname: c.info?.hostname || 'unknown',
      }, c.pendingRequestsCount + c.pendingTunnelsCount);
    }
  }

  updateCircuitBreakerGauge(clientId, state) {
    if (!this.enabled) return;
    const stateMap = { closed: 0, open: 1, half_open: 2 };
    this.circuitBreakerState.set({
      client_id: clientId.substring(0, 8),
    }, stateMap[state] || 0);
  }

  // ===========================================================================
  // Express middleware for /metrics endpoint
  // ===========================================================================
  metricsMiddleware() {
    return async (req, res) => {
      if (!this.enabled) {
        return res.status(404).send('Metrics disabled');
      }
      try {
        res.set('Content-Type', promClient.register.contentType);
        const metrics = await promClient.register.metrics();
        res.send(metrics);
      } catch (err) {
        res.status(500).send(`Error collecting metrics: ${err.message}`);
      }
    };
  }
}

module.exports = { MetricsManager };