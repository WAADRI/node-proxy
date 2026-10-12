// =============================================================================
// ACL Rule Engine - Access Control List for proxy traffic
// Phase 3: ACL Rule Engine
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose: only
// type-only imports are used (erased by Node type stripping), so this file
// loads as CommonJS and callers keep requiring it via require('./lib/acl.ts');
// ACLManager is exported through module.exports.
// =============================================================================

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const net = require('net');

import type { AppLogger } from './logger.ts';
import type { ServerConfig } from './config.ts';

// --- Typed shapes (config section / rule inputs / compiled artifacts) --------
interface AclSectionConfig {
  enabled?: boolean;
  rules?: AclRuleInput[];
}

// Structural view of the client context read by rule matching (id/tags only).
interface AclClientContext {
  id?: string;
  tags?: string[];
}

interface AclTimeWindowConfig {
  start: string;
  end: string;
}

interface AclMatchConditions {
  sourceIp?: string;
  targetDomain?: string;
  targetIp?: string;
  targetPort?: string;
  protocol?: string;
  clientTag?: string | string[];
  time?: AclTimeWindowConfig;
}

interface AclRuleInput {
  id?: string;
  action?: string;
  priority?: number;
  description?: string;
  match?: AclMatchConditions;
  enabled?: boolean;
}

interface CidrNet {
  ip: number;
  mask: number;
  bits: number;
}

interface PortRangeEntry {
  start: number;
  end: number;
}

interface TimeRangeMinutes {
  start: number;
  end: number;
}

interface AclRuleView {
  id: string;
  action: string;
  priority: number;
  description: string;
  match: AclMatchConditions;
  enabled: boolean;
  hits: number;
}

interface CompiledAclRule {
  id: string;
  action: string;
  priority: number;
  description: string;
  match: AclMatchConditions;
  enabled: boolean;
  createdAt: number;
  hits: number;
  // Pre-compiled match conditions (attached by addRule for fast matching)
  _sourceNets?: CidrNet[];
  _targetNets?: CidrNet[];
  _domainRegex?: RegExp | null;
  _portRange?: PortRangeEntry[] | null;
  _timeRange?: TimeRangeMinutes | null;
}

/**
 * ACL Rule Engine
 * Controls which clients can access which targets based on:
 * - Source IP ranges (CIDR)
 * - Target domains (wildcard)
 * - Target IP ranges (CIDR)
 * - Target ports
 * - Protocol (http, socks5, udp)
 * - Time-based restrictions
 * - Client tags
 */
class ACLManager {
  log: AppLogger;
  rules: CompiledAclRule[];
  enabled: boolean;
  _cache: Map<string, { result: boolean; time: number }>; // LRU cache for match results
  _cacheTTL: number; // 5 seconds

  constructor(config: ServerConfig, logger: AppLogger) {
    this.log = logger;
    this.rules = [];
    const aclSection = config.acl as AclSectionConfig | undefined;
    this.enabled = aclSection?.enabled !== false; // Fix: honor acl.enabled from config
    this._cache = new Map(); // LRU cache for match results
    this._cacheTTL = 5000; // 5 seconds

    // Load initial rules from config
    const rules = aclSection?.rules || [];
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  /**
   * Add an ACL rule
   * @param {Object} rule
   * @param {string} rule.action - 'allow' or 'deny'
   * @param {number} rule.priority - Higher priority wins (default 0)
   * @param {Object} rule.match - Match conditions
   * @param {string} [rule.match.sourceIp] - Source IP/CIDR
   * @param {string} [rule.match.targetDomain] - Target domain wildcard
   * @param {string} [rule.match.targetIp] - Target IP/CIDR
   * @param {string} [rule.match.targetPort] - Target port or range (e.g. "80", "1-1024")
   * @param {string} [rule.match.protocol] - Protocol: http, socks5, udp, any
   * @param {string} [rule.match.clientTag] - Client tag to match
   * @param {Object} [rule.match.time] - Time restriction { start: "HH:MM", end: "HH:MM" }
   * @param {string} rule.description - Human-readable description
   */
  addRule(rule: AclRuleInput): boolean {
    if (!rule.action || !['allow', 'deny'].includes(rule.action)) {
      this.log.error({ rule }, 'ACL rule must have action: allow or deny');
      return false;
    }

    const compiled: CompiledAclRule = {
      id: rule.id || this._generateId(),
      action: rule.action,
      priority: rule.priority || 0,
      description: rule.description || '',
      match: rule.match || {},
      enabled: rule.enabled !== false,
      createdAt: Date.now(),
      hits: 0,
    };

    // Pre-compile match conditions for performance. Anything that cannot be parsed
    // is refused here, loudly: a silently dropped condition used to become an empty
    // list, which matched everything (see _isInCIDR), so one typo could deny all
    // traffic - or, in an allow rule, permit all of it (#116).
    const reject = (field: string, value: unknown) => {
      this.log.error(
        { rule, field, value },
        'ACL rule rejected: unparseable condition (only IPv4 addresses/CIDRs and NUM or NUM-NUM ports are supported)'
      );
      return false;
    };
    if (compiled.match.sourceIp) {
      compiled._sourceNets = this._parseCIDR(compiled.match.sourceIp);
      if (!compiled._sourceNets.length) return reject('sourceIp', compiled.match.sourceIp);
    }
    if (compiled.match.targetIp) {
      compiled._targetNets = this._parseCIDR(compiled.match.targetIp);
      if (!compiled._targetNets.length) return reject('targetIp', compiled.match.targetIp);
    }
    if (compiled.match.targetDomain) {
      compiled._domainRegex = this._wildcardToRegex(compiled.match.targetDomain);
      if (!compiled._domainRegex) return reject('targetDomain', compiled.match.targetDomain);
    }
    if (compiled.match.targetPort) {
      compiled._portRange = this._parsePortRange(compiled.match.targetPort);
      if (!compiled._portRange || !compiled._portRange.length) return reject('targetPort', compiled.match.targetPort);
    }
    if (compiled.match.time) {
      compiled._timeRange = this._parseTimeRange(compiled.match.time);
    }

    this.rules.push(compiled);
    this.rules.sort((a, b) => b.priority - a.priority);
    this._cache.clear();
    return true;
  }

  /**
   * Remove an ACL rule by ID
   */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this._cache.clear();
    return true;
  }

  /**
   * List all ACL rules
   */
  listRules(): AclRuleView[] {
    return this.rules.map(r => ({
      id: r.id,
      action: r.action,
      priority: r.priority,
      description: r.description,
      match: r.match,
      enabled: r.enabled,
      hits: r.hits,
    }));
  }

  /**
   * Check a request against ACL rules
   * @param {Object} client - The client making the request
   * @param {string} targetHost - Target hostname or IP
   * @param {string} protocol - http, socks5, udp
   * @param {number} targetPort - Target port
   * @param {string} sourceIp - Source IP address
   * @returns {boolean} true if allowed, false if denied
   */
  check(client: AclClientContext | null, targetHost: string, protocol = 'http', targetPort = 0, sourceIp = ''): boolean {
    if (!this.rules.length) return true; // No rules = allow all
    if (!this.enabled) return true;

    // Check cache first
    const cacheKey = `${client?.id || ''}:${targetHost}:${protocol}:${targetPort}:${sourceIp}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this._cacheTTL) {
      return cached.result;
    }

    // Resolve target IP for matching
    let targetIp = '';
    if (targetHost && !net.isIP(targetHost)) {
      // For domain names, we'll match against the domain regex only
      // IP resolution is done at connection time
    } else if (targetHost) {
      targetIp = targetHost;
    }

    const clientId = client?.id || '';
    const clientTags = client?.tags || [];

    // Evaluate rules in priority order
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      const match = rule.match;

      // Check source IP
      if (match.sourceIp && sourceIp) {
        if (!this._isInCIDR(sourceIp, rule._sourceNets)) continue;
      }

      // Check target domain
      if (match.targetDomain && targetHost) {
        if (!rule._domainRegex || !rule._domainRegex.test(targetHost)) continue;
      }

      // Check target IP
      if (match.targetIp && targetIp) {
        if (!this._isInCIDR(targetIp, rule._targetNets)) continue;
      }

      // Check target port
      if (match.targetPort && targetPort) {
        if (!this._isInPortRange(targetPort, rule._portRange)) continue;
      }

      // Check protocol
      if (match.protocol && match.protocol !== 'any') {
        if (protocol !== match.protocol) continue;
      }

      // Check client tag
      if (match.clientTag) {
        const tagMatch = Array.isArray(match.clientTag)
          ? match.clientTag.some(tag => clientTags.includes(tag))
          : clientTags.includes(match.clientTag);
        if (!tagMatch) continue;
      }

      // Check time restriction
      if (match.time && rule._timeRange) {
        if (!this._isInTimeRange(rule._timeRange)) continue;
      }

      // All conditions matched - apply rule
      rule.hits++;
      this.log.debug({
        ruleId: rule.id,
        action: rule.action,
        clientId,
        targetHost,
        protocol,
      }, 'ACL rule matched');

      const result = rule.action === 'allow';
      this._cache.set(cacheKey, { result, time: Date.now() });
      return result;
    }

    // Default: allow if no rule matched
    this._cache.set(cacheKey, { result: true, time: Date.now() });
    return true;
  }

  /**
   * Get ACL statistics
   */
  getStats() {
    return {
      totalRules: this.rules.length,
      enabledRules: this.rules.filter(r => r.enabled).length,
      cacheSize: this._cache.size,
      rules: this.listRules(),
    };
  }

  /**
   * Clear state
   */
  reset() {
    this.rules = [];
    this._cache.clear();
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  _generateId(): string {
    return 'acl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  _parseCIDR(cidrStr: string): CidrNet[] {
    if (!cidrStr) return [];
    const parts = cidrStr.split(',');
    return parts
      .map(p => {
        p = p.trim();
        if (p.includes('/')) {
          const [ip, bits] = p.split('/');
          const mask = parseInt(bits, 10);
          // A prefix outside 0..32 used to shift into a wildly different mask
          // (/33 became /1, matching half the internet) instead of being rejected.
          if (!/^\d{1,2}$/.test(bits) || !Number.isInteger(mask) || mask > 32) return null;
          const ipLong = this._ipToLong(ip);
          if (ipLong === null) return null;
          return { ip: ipLong, mask, bits };
        } else {
          if (net.isIP(p)) {
            const ipLong = this._ipToLong(p);
            if (ipLong === null) return null;
            return { ip: ipLong, mask: 32, bits: 32 };
          }
          return null;
        }
      })
      .filter((n): n is CidrNet => n !== null);
  }

  _ipToLong(ip: string): number | null {
    // A dual-stack listener (server.ts binds '::') reports an IPv4 peer as
    // ::ffff:1.2.3.4, which net.isIPv4 rejects - so every IPv4 sourceIp rule
    // silently stopped matching and fell through to the default policy (#116).
    const normalized = (ip || '').replace(/^::ffff:/i, '');
    if (!net.isIPv4(normalized)) return null;
    const parts = normalized.split('.');
    return ((parseInt(parts[0], 10) << 24) |
            (parseInt(parts[1], 10) << 16) |
            (parseInt(parts[2], 10) << 8) |
            parseInt(parts[3], 10)) >>> 0;
  }

  _isInCIDR(ip: string, nets?: CidrNet[] | null): boolean {
    // An empty list means "this condition could not be parsed", which must never
    // match anything (addRule refuses such rules up front). Returning true used to
    // make a typo deny all traffic in a deny rule and allow all of it in an allow
    // rule - the same empty list, two opposite silent failures (#116).
    if (!nets || !nets.length) return false;
    const ipLong = this._ipToLong(ip);
    if (ipLong === null) return false;
    return nets.some(net => {
      if (!net) return false;
      const mask = net.bits === 0 ? 0 : (0xFFFFFFFF << (32 - net.bits)) >>> 0;
      return (ipLong & mask) === (net.ip & mask);
    });
  }

  _wildcardToRegex(pattern: string): RegExp | null {
    if (!pattern) return null;
    // A comma-separated list is what config.yaml documents, but the whole string
    // used to be compiled as ONE literal pattern, so `*.a.com,*.b.com` matched
    // neither host and the rule silently did nothing (#116).
    const alternatives = pattern
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p =>
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^.]*')
          .replace(/\?/g, '.')
      );
    if (!alternatives.length) return null;
    return new RegExp(`^(?:${alternatives.join('|')})$`, 'i');
  }

  _parsePortRange(portStr: string): PortRangeEntry[] | null {
    if (!portStr) return null;
    // Validate instead of coercing: '80-' produced {start:80,end:0} (Number('') is
    // 0, not NaN) - an empty range that matched nothing, so a deny rule silently
    // stopped working, while '80-abc' became 80-65535 and matched everything.
    const out: PortRangeEntry[] = [];
    for (const raw of portStr.split(',')) {
      const p = raw.trim();
      const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
      if (!m) return null;
      const start = Number(m[1]);
      const end = m[2] === undefined ? start : Number(m[2]);
      if (start > 65535 || end > 65535 || start > end) return null;
      out.push({ start, end });
    }
    return out.length ? out : null;
  }

  _isInPortRange(port: number, ranges?: PortRangeEntry[] | null): boolean {
    if (!ranges) return true;
    return ranges.some(r => port >= r.start && port <= r.end);
  }

  _parseTimeRange(time?: AclTimeWindowConfig): TimeRangeMinutes | null {
    if (!time || !time.start || !time.end) return null;
    const parseTime = (t: string): number => {
      const parts = t.split(':').map(Number);
      return parts[0] * 60 + (parts[1] || 0);
    };
    return { start: parseTime(time.start), end: parseTime(time.end) };
  }

  _isInTimeRange(range?: TimeRangeMinutes | null): boolean {
    if (!range) return true;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    if (range.start <= range.end) {
      return currentMinutes >= range.start && currentMinutes <= range.end;
    } else {
      // Overnight range (e.g. 22:00 - 06:00)
      return currentMinutes >= range.start || currentMinutes <= range.end;
    }
  }
}

module.exports = { ACLManager };
