// =============================================================================
// DomainRouter - Domain name rule engine for tag-based routing
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; Node 24 type
// stripping runs it via require('./lib/domain-router.ts').
// =============================================================================

import type { ServerConfig, DomainRuleEntry } from './config.ts';
import type { AppLogger } from './logger.ts';

interface DomainRule {
  pattern: string;
  regex: RegExp;
  tag: string;
  priority: number;
}

export class DomainRouter {
  config: ServerConfig;
  log: AppLogger;
  private rules: DomainRule[] = [];

  constructor(config: ServerConfig, logger: AppLogger) {
    this.config = config;
    this.log = logger;
    this._loadRules();
  }

  private _loadRules() {
    const rules = this.config.domain_rules || [];
    for (const r of rules) {
      this.addRule(r.pattern, r.tag, r.priority || 0);
    }
    if (rules.length > 0) {
      this.log.info({ count: rules.length }, 'Domain rules loaded');
    }
  }

  // Add a rule: pattern like "*.example.com" or "api.example.com" or "*.example.*"
  addRule(pattern: string, tag: string, priority = 0): boolean {
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
      this.rules.push({ pattern, regex, tag, priority });
      // Sort by priority descending (highest priority first)
      this.rules.sort((a, b) => b.priority - a.priority);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ pattern, error: message }, 'Invalid domain rule pattern');
      return false;
    }
  }

  removeRule(pattern: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.pattern !== pattern);
    return this.rules.length < before;
  }

  listRules(): DomainRuleEntry[] {
    return this.rules.map((r) => ({ pattern: r.pattern, tag: r.tag, priority: r.priority }));
  }

  // Match a domain to a tag. Returns tag string or null.
  match(hostname: string): string | null {
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

function regexEscape(str: string): string {
  return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
