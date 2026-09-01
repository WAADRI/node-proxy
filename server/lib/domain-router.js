// =============================================================================
// DomainRouter - Domain name rule engine for tag-based routing
// =============================================================================
'use strict';

class DomainRouter {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.rules = []; // [{ pattern: string, regex: RegExp, tag: string, priority: number }]
    this._loadRules();
  }

  _loadRules() {
    const rules = this.config.domain_rules || [];
    for (const r of rules) {
      this.addRule(r.pattern, r.tag, r.priority || 0);
    }
    if (rules.length > 0) {
      this.log.info({ count: rules.length }, 'Domain rules loaded');
    }
  }

  // Add a rule: pattern like "*.example.com" or "api.example.com" or "*.example.*"
  addRule(pattern, tag, priority = 0) {
    // Convert wildcard pattern to regex
    let regexStr = '^';
    const parts = pattern.split('*');
    for (let i = 0; i < parts.length; i++) {
      regexStr += regexEscape(parts[i]);
      if (i < parts.length - 1) regexStr += '.*';
    }
    regexStr += '$';

    try {
      const regex = new RegExp(regexStr, 'i');
      const rule = { pattern, regex, tag, priority };
      this.rules.push(rule);
      // Sort by priority descending (highest priority first)
      this.rules.sort((a, b) => b.priority - a.priority);
      return true;
    } catch (err) {
      this.log.error({ pattern, error: err.message }, 'Invalid domain rule pattern');
      return false;
    }
  }

  removeRule(pattern) {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => r.pattern !== pattern);
    return this.rules.length < before;
  }

  listRules() {
    return this.rules.map(r => ({ pattern: r.pattern, tag: r.tag, priority: r.priority }));
  }

  // Match a domain to a tag. Returns tag string or null.
  match(hostname) {
    if (!hostname || this.rules.length === 0) return null;
    // Remove port if present
    const host = hostname.split(':')[0].toLowerCase();
    for (const rule of this.rules) {
      if (rule.regex.test(host)) {
        return rule.tag;
      }
    }
    return null;
  }

  clear() {
    this.rules = [];
  }
}

function regexEscape(str) {
  return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { DomainRouter };