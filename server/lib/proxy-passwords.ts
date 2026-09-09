// =============================================================================
// Proxy Passwords - multiple HTTP/SOCKS5 proxy passwords (issue #53)
// Each generated password can route traffic to a node tag/group (the tag
// filter also matches group names, which act as implicit tags) or force a
// single node by its UUID, and can carry its own routing strategy.
//
// Persisted as a JSON array under the config_overrides key 'proxy_passwords'
// so entries survive restarts and are editable from the web panel.
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import type { RoutingStrategy } from './router.ts';

export interface ProxyPasswordEntry {
  id: string;
  label: string;
  password: string;
  tag: string | null;
  clientId: string | null;
  strategy: RoutingStrategy | null;
  enabled: boolean;
  createdAt: number;
}

export type ProxyPasswordInput = Partial<Pick<ProxyPasswordEntry, 'label' | 'password' | 'tag' | 'clientId' | 'strategy' | 'enabled'>>;

interface ConfigOverrideStore {
  getConfigOverride(key: string): unknown;
  setConfigOverride(key: string, value: unknown): void;
  deleteConfigOverride(key: string): void;
}

const STORAGE_KEY = 'proxy_passwords';
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_LABEL_LENGTH = 50;

export function generateProxyPassword(): string {
  // 16 random bytes -> 22 chars of unpadded base64url (no look-alikes/ambiguity issues)
  return randomBytes(16).toString('base64url');
}

function cleanString(value: unknown, maxLen: number): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export class ProxyPasswordManager {
  private store: ConfigOverrideStore;

  constructor(store: ConfigOverrideStore) {
    this.store = store;
  }

  list(): ProxyPasswordEntry[] {
    const raw = this.store.getConfigOverride(STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => this._normalize(e))
      .filter((e): e is ProxyPasswordEntry => e !== null);
  }

  private _normalize(raw: Record<string, unknown>): ProxyPasswordEntry | null {
    const password = typeof raw.password === 'string' ? raw.password : '';
    if (!password) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uuidv4(),
      label: typeof raw.label === 'string' ? raw.label : '',
      password,
      tag: typeof raw.tag === 'string' && raw.tag ? raw.tag : null,
      clientId: typeof raw.clientId === 'string' && raw.clientId ? raw.clientId : null,
      strategy:
        raw.strategy === 'least-loaded' || raw.strategy === 'fastest-response' || raw.strategy === 'weighted' || raw.strategy === 'random'
          ? raw.strategy
          : null,
      enabled: raw.enabled !== false,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    };
  }

  private _persist(entries: ProxyPasswordEntry[]) {
    this.store.setConfigOverride(STORAGE_KEY, entries);
  }

  // Validate routing fields of a single entry (mutual exclusivity etc.)
  validateRouting(input: ProxyPasswordInput): { ok: boolean; error?: string } {
    if (input.tag && input.clientId) {
      return { ok: false, error: 'tag and clientId are mutually exclusive' };
    }
    return { ok: true };
  }

  create(input: ProxyPasswordInput): { ok: boolean; error?: string; entry?: ProxyPasswordEntry } {
    const routing = this.validateRouting(input);
    if (!routing.ok) return routing;
    const password = typeof input.password === 'string' && input.password.trim() ? input.password.trim() : generateProxyPassword();
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return { ok: false, error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters` };
    }
    const label = cleanString(input.label, MAX_LABEL_LENGTH);
    if (input.label != null && label === '') {
      return { ok: false, error: 'Label must not be empty' };
    }
    const existing = this.list();
    if (existing.some((e) => e.password === password)) {
      return { ok: false, error: 'A password with the same value already exists' };
    }
    const entry: ProxyPasswordEntry = {
      id: uuidv4(),
      label,
      password,
      tag: typeof input.tag === 'string' && input.tag.trim() ? input.tag.trim() : null,
      clientId: typeof input.clientId === 'string' && input.clientId.trim() ? input.clientId.trim() : null,
      strategy: this._validStrategy(input.strategy),
      enabled: input.enabled !== false,
      createdAt: Date.now(),
    };
    this._persist([...existing, entry]);
    return { ok: true, entry };
  }

  update(id: string, patch: ProxyPasswordInput): { ok: boolean; error?: string; entry?: ProxyPasswordEntry } {
    const entries = this.list();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return { ok: false, error: 'Proxy password not found' };
    const current = entries[idx];
    const next: ProxyPasswordEntry = { ...current };
    if (patch.password !== undefined) {
      const password = typeof patch.password === 'string' ? patch.password.trim() : '';
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return { ok: false, error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters` };
      }
      next.password = password;
    }
    if (patch.label !== undefined) {
      next.label = cleanString(patch.label, MAX_LABEL_LENGTH);
    }
    if (patch.tag !== undefined) {
      next.tag = typeof patch.tag === 'string' && patch.tag.trim() ? patch.tag.trim() : null;
    }
    if (patch.clientId !== undefined) {
      next.clientId = typeof patch.clientId === 'string' && patch.clientId.trim() ? patch.clientId.trim() : null;
    }
    if (patch.strategy !== undefined) {
      next.strategy = this._validStrategy(patch.strategy);
    }
    if (patch.enabled !== undefined) {
      next.enabled = patch.enabled !== false;
    }
    const routing = this.validateRouting({ tag: next.tag ?? undefined, clientId: next.clientId ?? undefined });
    if (!routing.ok) return routing;
    if (entries.some((e, i) => i !== idx && e.password === next.password)) {
      return { ok: false, error: 'A password with the same value already exists' };
    }
    entries[idx] = next;
    this._persist(entries);
    return { ok: true, entry: next };
  }

  regenerate(id: string): { ok: boolean; error?: string; entry?: ProxyPasswordEntry } {
    return this.update(id, { password: generateProxyPassword() });
  }

  remove(id: string): { ok: boolean; error?: string } {
    const entries = this.list();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return { ok: false, error: 'Proxy password not found' };
    this._persist(next);
    return { ok: true };
  }

  private _validStrategy(value: unknown): RoutingStrategy | null {
    if (value === 'random' || value === 'least-loaded' || value === 'fastest-response' || value === 'weighted') {
      return value;
    }
    return null;
  }
}
