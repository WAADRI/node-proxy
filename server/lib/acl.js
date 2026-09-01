// =============================================================================
// ACL Rule Engine - Access Control List for proxy traffic
// Phase 3: ACL Rule Engine
// =============================================================================
'use strict';

const net = require('net');

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
  constructor(config, logger) {
    this.log = logger;
    this.rules = [];
    this.enabled = config.acl?.enabled !== false; // Fix: honor acl.enabled from config
    this._cache = new Map(); // LRU cache for match results
    this._cacheTTL = 5000; // 5 seconds

    // Load initial rules from config
    const rules = config.acl?.rules || [];
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
  addRule(rule) {
    if (!rule.action || !['allow', 'deny'].includes(rule.action)) {
      this.log.error({ rule }, 'ACL rule must have action: allow or deny');
      return false;
    }

    const compiled = {
      id: rule.id || this._generateId(),
      action: rule.action,
      priority: rule.priority || 0,
      description: rule.description || '',
      match: rule.match || {},
      enabled: rule.enabled !== false,
      createdAt: Date.now(),
      hits: 0,
    };

    // Pre-compile match conditions for performance
    if (compiled.match.sourceIp) {
      compiled._sourceNets = this._parseCIDR(compiled.match.sourceIp);
    }
    if (compiled.match.targetIp) {
      compiled._targetNets = this._parseCIDR(compiled.match.targetIp);
    }
    if (compiled.match.targetDomain) {
      compiled._domainRegex = this._wildcardToRegex(compiled.match.targetDomain);
    }
    if (compiled.match.targetPort) {
      compiled._portRange = this._parsePortRange(compiled.match.targetPort);
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
  removeRule(ruleId) {
    const idx = this.rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this._cache.clear();
    return true;
  }

  /**
   * List all ACL rules
   */
  listRules() {
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
  check(client, targetHost, protocol = 'http', targetPort = 0, sourceIp = '') {
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

  _generateId() {
    return 'acl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  _parseCIDR(cidrStr) {
    if (!cidrStr) return [];
    const parts = cidrStr.split(',');
    return parts.map(p => {
      p = p.trim();
      if (p.includes('/')) {
        const [ip, bits] = p.split('/');
        const mask = parseInt(bits, 10);
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
    }).filter(Boolean);
  }

  _ipToLong(ip) {
    if (!net.isIPv4(ip)) return null;
    const parts = ip.split('.');
    return ((parseInt(parts[0], 10) << 24) |
            (parseInt(parts[1], 10) << 16) |
            (parseInt(parts[2], 10) << 8) |
            parseInt(parts[3], 10)) >>> 0;
  }

  _isInCIDR(ip, nets) {
    if (!nets || !nets.length) return true;
    const ipLong = this._ipToLong(ip);
    if (ipLong === null) return false;
    return nets.some(net => {
      if (!net) return false;
      const mask = net.bits === 0 ? 0 : (0xFFFFFFFF << (32 - net.bits)) >>> 0;
      return (ipLong & mask) === (net.ip & mask);
    });
  }

  _wildcardToRegex(pattern) {
    if (!pattern) return null;
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^.]*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  }

  _parsePortRange(portStr) {
    if (!portStr) return null;
    const parts = portStr.split(',');
    return parts.map(p => {
      p = p.trim();
      if (p.includes('-')) {
        const [start, end] = p.split('-').map(Number);
        return { start: isNaN(start) ? 0 : start, end: isNaN(end) ? 65535 : end };
      }
      const port = parseInt(p, 10);
      if (isNaN(port)) return null;
      return { start: port, end: port };
    }).filter(Boolean);
  }

  _isInPortRange(port, ranges) {
    if (!ranges) return true;
    return ranges.some(r => port >= r.start && port <= r.end);
  }

  _parseTimeRange(time) {
    if (!time || !time.start || !time.end) return null;
    const parseTime = (t) => {
      const parts = t.split(':').map(Number);
      return parts[0] * 60 + (parts[1] || 0);
    };
    return { start: parseTime(time.start), end: parseTime(time.end) };
  }

  _isInTimeRange(range) {
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