// =============================================================================
// Router - Multiple routing strategies for client selection
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; Node 24 type
// stripping runs it via require('./lib/router.ts').
// =============================================================================

import type { ServerConfig } from './config.ts';
import type { AppLogger } from './logger.ts';
import type { ClientNode } from './client-manager.ts';
// Value import: client-manager does not import Router at runtime, so there is
// no import cycle. clientEffectiveTags keeps tag matching in sync with group
// membership (issue #53: group name = implicit tag).
import { clientEffectiveTags } from './client-manager.ts';

export type RoutingStrategy = 'random' | 'least-loaded' | 'fastest-response' | 'weighted';

const STRATEGIES: RoutingStrategy[] = ['random', 'least-loaded', 'fastest-response', 'weighted'];

// Minimal circuit-breaker contract used at selection time.
interface RouterCircuitBreakerLike {
  isAllowed(clientId: string): boolean;
}

export class Router {
  config: ServerConfig;
  log: AppLogger;
  strategy: RoutingStrategy;
  private responseTimes: Map<string, number> = new Map(); // clientId -> moving average
  private weights: Map<string, number> = new Map(); // clientId -> weight

  constructor(config: ServerConfig, logger: AppLogger) {
    this.config = config;
    this.log = logger;
    const initial = config.routing?.strategy;
    this.strategy = STRATEGIES.includes(initial as RoutingStrategy) ? (initial as RoutingStrategy) : 'random';
  }

  setStrategy(strategy: string): boolean {
    if (STRATEGIES.includes(strategy as RoutingStrategy)) {
      this.strategy = strategy as RoutingStrategy;
      return true;
    }
    return false;
  }

  getStrategy(): RoutingStrategy {
    return this.strategy;
  }

  // Select a client from available clients using the configured strategy
  select(clients: ClientNode[], circuitBreaker: RouterCircuitBreakerLike | null, tag?: string | null): ClientNode | null {
    if (!clients || clients.length === 0) return null;

    // Filter by circuit breaker
    let candidates = clients.filter((c) => {
      // Skip clients that are OPEN in circuit breaker
      if (circuitBreaker) {
        return circuitBreaker.isAllowed(c.id);
      }
      return true;
    });

    if (candidates.length === 0) return null;

    // Filter by tag if specified (matches effective tags: explicit tags plus
    // the implicit group tag, issue #53)
    if (tag) {
      const tagLower = tag.toLowerCase();
      candidates = candidates.filter((c) => {
        return clientEffectiveTags(c).some((t) => t.toLowerCase() === tagLower);
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

  private _random(candidates: ClientNode[]): ClientNode {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private _leastLoaded(candidates: ClientNode[]): ClientNode {
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

  private _fastestResponse(candidates: ClientNode[]): ClientNode {
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

  private _weighted(candidates: ClientNode[]): ClientNode {
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
  recordResponseTime(clientId: string | null | undefined, durationMs: number) {
    if (!clientId) return;
    const alpha = 0.3; // smoothing factor
    const current = this.responseTimes.get(clientId);
    if (current === undefined) {
      this.responseTimes.set(clientId, durationMs);
    } else {
      this.responseTimes.set(clientId, alpha * durationMs + (1 - alpha) * current);
    }
  }

  // Set weight for a client (used by weighted strategy)
  setWeight(clientId: string, weight: number) {
    this.weights.set(clientId, Math.max(1, weight));
  }

  getWeight(clientId: string): number {
    return this.weights.get(clientId) || 1;
  }

  getResponseTime(clientId: string): number {
    return this.responseTimes.get(clientId) || 0;
  }

  getAllResponseTimes(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, time] of this.responseTimes) {
      result[id] = Math.round(time);
    }
    return result;
  }

  // Cleanup stale entries
  cleanup(activeClientIds: Iterable<string>) {
    const activeSet = new Set(activeClientIds);
    for (const id of this.responseTimes.keys()) {
      if (!activeSet.has(id)) this.responseTimes.delete(id);
    }
    for (const id of this.weights.keys()) {
      if (!activeSet.has(id)) this.weights.delete(id);
    }
  }
}
