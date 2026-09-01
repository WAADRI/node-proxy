// =============================================================================
// Router - Multiple routing strategies for client selection
// =============================================================================
'use strict';

class Router {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.strategy = config.routing?.strategy || 'random';
    this.responseTimes = new Map(); // clientId -> [moving average]
    this.weights = new Map(); // clientId -> weight
  }

  setStrategy(strategy) {
    if (['random', 'least-loaded', 'fastest-response', 'weighted'].includes(strategy)) {
      this.strategy = strategy;
      return true;
    }
    return false;
  }

  // Select a client from available clients using the configured strategy
  select(clients, circuitBreaker, tag) {
    if (!clients || clients.length === 0) return null;

    // Filter by circuit breaker
    let candidates = clients.filter(c => {
      // Skip clients that are OPEN in circuit breaker
      if (circuitBreaker) {
        return circuitBreaker.isAllowed(c.id);
      }
      return true;
    });

    if (candidates.length === 0) return null;

    // Filter by tag if specified
    if (tag) {
      const tagLower = tag.toLowerCase();
      candidates = candidates.filter(c => {
        const tags = c.info?.tags || [];
        return tags.some(t => t.toLowerCase() === tagLower);
      });
      if (candidates.length === 0) return null;
    }

    switch (this.strategy) {
      case 'least-loaded':
        return this._leastLoaded(candidates);
      case 'fastest-response':
        return this._fastestResponse(candidates);
      case 'weighted':
        return this._weighted(candidates);
      case 'random':
      default:
        return this._random(candidates);
    }
  }

  _random(candidates) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  _leastLoaded(candidates) {
    let best = candidates[0];
    let minLoad = Infinity;
    for (const c of candidates) {
      const load = (c.pendingRequests?.size || 0) + (c.pendingTunnels?.size || 0);
      if (load < minLoad) {
        minLoad = load;
        best = c;
      }
    }
    return best;
  }

  _fastestResponse(candidates) {
    let best = candidates[0];
    let bestTime = Infinity;
    for (const c of candidates) {
      const avgTime = this.responseTimes.get(c.id);
      if (avgTime === undefined || avgTime < bestTime) {
        bestTime = avgTime === undefined ? 0 : avgTime;
        best = c;
      }
    }
    return best;
  }

  _weighted(candidates) {
    const totalWeight = candidates.reduce((sum, c) => {
      return sum + (this.weights.get(c.id) || 1);
    }, 0);
    let random = Math.random() * totalWeight;
    for (const c of candidates) {
      const w = this.weights.get(c.id) || 1;
      random -= w;
      if (random <= 0) return c;
    }
    return candidates[candidates.length - 1];
  }

  // Record response time for a client (exponential moving average)
  recordResponseTime(clientId, durationMs) {
    const alpha = 0.3; // smoothing factor
    const current = this.responseTimes.get(clientId);
    if (current === undefined) {
      this.responseTimes.set(clientId, durationMs);
    } else {
      this.responseTimes.set(clientId, alpha * durationMs + (1 - alpha) * current);
    }
  }

  // Set weight for a client (used by weighted strategy)
  setWeight(clientId, weight) {
    this.weights.set(clientId, Math.max(1, weight));
  }

  getWeight(clientId) {
    return this.weights.get(clientId) || 1;
  }

  getResponseTime(clientId) {
    return this.responseTimes.get(clientId) || 0;
  }

  getAllResponseTimes() {
    const result = {};
    for (const [id, time] of this.responseTimes) {
      result[id] = Math.round(time);
    }
    return result;
  }

  // Cleanup stale entries
  cleanup(activeClientIds) {
    const activeSet = new Set(activeClientIds);
    for (const [id] of this.responseTimes) {
      if (!activeSet.has(id)) this.responseTimes.delete(id);
    }
    for (const [id] of this.weights) {
      if (!activeSet.has(id)) this.weights.delete(id);
    }
  }
}

module.exports = { Router };