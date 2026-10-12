// =============================================================================
// Auth v3.0 - Multi-user authentication with RBAC (Role-Based Access Control)
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; Node 24 type
// stripping runs it via require('./lib/auth.ts').
// =============================================================================

import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import type { Response, NextFunction } from 'express';
import type { ServerConfig } from './config.ts';
import type { AppLogger } from './logger.ts';
import type { ProxyPasswordEntry } from './proxy-passwords.ts';
import type { RoutingStrategy } from './router.ts';
import { createHash, timingSafeEqual } from 'crypto';
// Default import, deliberately NOT a namespace import. This repo runs .ts directly through
// Node's type stripping, so a namespace import is handed to Node as a REAL ESM namespace
// import of a CJS package: bcryptjs's named exports are not statically detectable, so the
// namespace carries only `default`/`module.exports`, bcrypt.hashSync is undefined, and every
// login threw `TypeError: bcrypt.hashSync is not a function` (measured: namespace.hashSync =
// undefined, namespace.default.hashSync = function).
import bcrypt from 'bcryptjs';

export type RoleName = 'admin' | 'operator' | 'viewer';

const VALID_ROLES: RoleName[] = ['admin', 'operator', 'viewer'];

function toRoleName(value: string | undefined): RoleName {
  if (value === 'admin' || value === 'operator' || value === 'viewer') return value;
  return 'viewer';
}

// Built-in roles with permission sets
// Constant-time comparison for secrets. `===` on a password or token short-circuits
// at the first differing byte, so an attacker who can time the response learns the
// matching prefix byte by byte (issue #117). Hashing first also keeps the lengths
// equal, which timingSafeEqual requires.
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
// A bcrypt hash is recognisable by its $2a/$2b/$2y prefix, which is also how legacy
// plaintext records are told apart - so no offline migration is needed (issue #117).
function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$/.test(String(value || ''));
}

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export const ROLES: Record<RoleName, { permissions: string[] }> = {
  admin: {
    permissions: [
      'client:list', 'client:kick', 'client:tag', 'client:weight',
      'client:bandwidth', 'client:events', 'client:alias', 'client:notes', 'client:region', 'client:group',
      'proxy:config', 'proxy:stats', 'proxy:passwords',
      'routing:config', 'routing:strategy',
      'circuit:reset', 'circuit:view',
      'system:config', 'system:logs', 'nettest:run',
      'user:list', 'user:create', 'user:delete', 'user:modify',
      'domain:list', 'domain:create', 'domain:delete', 'domain:modify',
      'cache:clear', 'cache:view',
      'plugin:list', 'plugin:install', 'plugin:uninstall',
      'metrics:view',
      'acl:list', 'acl:create', 'acl:delete',
      'audit:query',
    ],
  },
  operator: {
    permissions: [
      'client:list', 'client:kick', 'client:tag', 'client:weight',
      'client:bandwidth', 'client:events', 'client:alias', 'client:notes', 'client:region', 'client:group',
      'proxy:stats', 'proxy:passwords',
      'routing:strategy',
      'circuit:reset', 'circuit:view',
      'nettest:run',
      'domain:list', 'domain:create', 'domain:delete', 'domain:modify',
      'cache:clear', 'cache:view',
      'metrics:view',
      'acl:list',
      'audit:query',
    ],
  },
  viewer: {
    permissions: [
      'client:list', 'client:events',
      'proxy:stats',
      'circuit:view',
      'domain:list',
      'cache:view',
      'metrics:view',
      'acl:list',
    ],
  },
};

interface AuthUserValue {
  password: string;
  role: RoleName;
  enabled: boolean;
  createdAt: number;
  // Bumped whenever existing tokens must stop working (e.g. a password change). Tokens carry
  // the value they were issued with, so a stateless JWT can still be revoked (issue #118).
  tokenVersion?: number;
}

// Request enriched by the auth middleware with the authenticated user.
// Structural subset of express.Request so the middleware stays decoupled
// from @types/express version-specific cookie typing.
export interface AuthWebRequest {
  path: string;
  headers: { authorization?: string | string[] };
  cookies?: Record<string, string>;
  user?: string;
  role?: string;
}

export type WebAuthResult =
  | { valid: true; username?: string; role?: string }
  | { valid: false; error?: string };

export type AuthMiddleware = (req: AuthWebRequest, res: Response, next: NextFunction) => void;

// Routing directive resolved from a proxy credential (issue #53): empty route
// = default pool with the global routing strategy; tag = filter to nodes whose
// tags/groups include it (used with a per-password strategy); clientId = force
// that node. strategy overrides the global strategy for this request.
export interface ProxyRoute {
  tag?: string | null;
  clientId?: string | null;
  strategy?: RoutingStrategy | null;
}

export class AuthManager {
  config: ServerConfig;
  log: AppLogger;
  private jwtSecret: string;
  private users: Map<string, AuthUserValue> = new Map(); // username -> entry
  // Injected providers for multi-password proxy auth (issue #53). Kept as
  // setters to avoid an import cycle: server.ts wires the storage-backed
  // password manager and the live client registry after construction.
  private proxyPasswordProvider: (() => ProxyPasswordEntry[]) | null = null;
  private clientIdResolver: ((password: string) => string | null) | null = null;

  // Node selected by a resolved proxy route...
  setProxyPasswordProvider(provider: () => ProxyPasswordEntry[]) {
    this.proxyPasswordProvider = provider;
  }

  // Returns the id of a connected node whose UUID equals `password`, else null.
  setClientIdResolver(resolver: (password: string) => string | null) {
    this.clientIdResolver = resolver;
  }

  constructor(config: ServerConfig, logger: AppLogger) {
    this.config = config;
    this.log = logger;
    this.jwtSecret = config.auth.web?.jwt_secret || randomBytes(32).toString('hex');
    this._initUsers();
  }

  private _initUsers() {
    const web = this.config.auth.web || {};
    // Always add the configured admin user
    this.users.set(web.username || 'admin', {
      password: web.password || 'admin123',
      role: 'admin',
      enabled: true,
      createdAt: Date.now(),
    });
    // Load additional users from config
    const extraUsers = this.config.auth.users || [];
    for (const u of extraUsers) {
      this.users.set(u.username, {
        password: u.password || '',
        role: toRoleName(u.role),
        enabled: u.enabled !== false,
        createdAt: Date.now(),
      });
    }
  }

  // ===========================================================================
  // User Management
  // ===========================================================================
  listUsers(): { username: string; role: RoleName; enabled: boolean; createdAt: number }[] {
    const result: { username: string; role: RoleName; enabled: boolean; createdAt: number }[] = [];
    for (const [username, data] of this.users) {
      result.push({
        username,
        role: data.role,
        enabled: data.enabled,
        createdAt: data.createdAt,
      });
    }
    return result;
  }

  addUser(username: string, password: string, role: RoleName = 'viewer'): boolean {
    if (this.users.has(username)) return false;
    if (!VALID_ROLES.includes(role)) return false;
    this.users.set(username, { password, role, enabled: true, createdAt: Date.now() });
    return true;
  }

  deleteUser(username: string): boolean {
    // Cannot delete the last admin
    // Count ENABLED admins only: counting every admin allowed deleting the only
    // usable one while a disabled admin remained - a lockout too (issue #117).
    const adminCount = this.listUsers().filter((u) => u.role === 'admin' && u.enabled).length;
    const user = this.users.get(username);
    if (user && user.role === 'admin' && adminCount <= 1) return false;
    return this.users.delete(username);
  }

  modifyUser(username: string, updates: { password?: string; role?: string; enabled?: boolean }): boolean {
    const user = this.users.get(username);
    if (!user) return false;
    // Refuse to leave the panel without an ENABLED admin. deleteUser guarded this;
    // modifyUser did not, so the last admin could be demoted or disabled - by
    // themselves or by another admin - and nobody could reach user management ever
    // again (issue #117). Only enforced when this change removes the last one, and
    // an invalid role is ignored later anyway, so it must not trigger the refusal.
    const demotes =
      updates.role !== undefined && updates.role !== 'admin' && VALID_ROLES.includes(updates.role as RoleName);
    const disables = updates.enabled === false;
    const wasEnabledAdmin = user.enabled && user.role === 'admin';
    const enabledAdmins = [...this.users.values()].filter((u) => u.enabled && u.role === 'admin').length;
    if (wasEnabledAdmin && (demotes || disables) && enabledAdmins <= 1) return false;
    // Store a hash, never the plaintext (issue #117).
    if (updates.password) {
      // Store the bcrypt hash (PR #163) AND advance the epoch (PR #193) - the two changes touch
      // the same statement, which is exactly where the merge conflict was: keeping only one of
      // them either loses the hashing or leaves old tokens valid.
      user.password = hashPassword(updates.password);
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    if (updates.role && VALID_ROLES.includes(updates.role as RoleName)) user.role = updates.role as RoleName;
    if (updates.enabled !== undefined) user.enabled = updates.enabled;
    return true;
  }

  getRole(username: string): RoleName | null {
    const user = this.users.get(username);
    return user ? user.role : null;
  }

  // ===========================================================================
  // Permission Check
  // ===========================================================================
  hasPermission(username: string, permission: string): boolean {
    const user = this.users.get(username);
    if (!user || !user.enabled) return false;
    const role = ROLES[user.role];
    if (!role) return false;
    return role.permissions.includes(permission);
  }

  getPermissions(username: string): string[] {
    const user = this.users.get(username);
    if (!user || !user.enabled) return [];
    const role = ROLES[user.role];
    return role ? [...role.permissions] : [];
  }

  // ===========================================================================
  // Web Panel Authentication (JWT)
  // ===========================================================================
  validateWebLogin(username: string, password: string): boolean {
    const webAuth = this.config.auth.web;
    if (!webAuth.enabled) return true;
    const user = this.users.get(username);
    if (!user || !user.enabled) return false;
    if (isBcryptHash(user.password)) return bcrypt.compareSync(password, user.password);
    // Legacy plaintext record: verify, then upgrade in place so the plaintext does
    // not survive the first successful login (issue #117).
    if (!safeEqual(user.password, password)) return false;
    user.password = hashPassword(password);
    return true;
  }

  generateWebToken(username: string): string {
    const user = this.users.get(username);
    const role = user ? user.role : 'viewer';
    const payload = {
      sub: username,
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      // The epoch this token belongs to; verification compares it with the live user.
      ver: user?.tokenVersion || 0,
    };
    return jwt.sign(payload, this.jwtSecret);
  }

  // Revoke every token already issued to this user by advancing the epoch that issued tokens
  // carry (see tokenVersion). A stateless JWT cannot be cancelled any other way, so logout and
  // password change both come down to this (issue #118).
  revokeUserTokens(username: string): boolean {
    const user = this.users.get(username);
    if (!user) return false;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    return true;
  }
  verifyWebToken(token: string): WebAuthResult {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      if (typeof payload === 'string') {
        return { valid: false, error: 'unexpected string payload' };
      }
      const role = typeof payload.role === 'string' ? payload.role : undefined;
      const username = typeof payload.sub === 'string' ? payload.sub : undefined;
      // Stateless tokens stay valid for their full 24h, so a password change (or a deleted
      // account) could not take effect. Compare the epoch the token was issued with against
      // the live user: a mismatch means it was revoked (issue #118).
      if (username) {
        const live = this.users.get(username);
        const expected = live ? live.tokenVersion || 0 : -1;
        const issued = typeof payload.ver === 'number' ? payload.ver : 0;
        if (!live || issued !== expected) return { valid: false, error: 'token revoked' };
      }
      return { valid: true, username, role };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, error: message };
    }
  }

  // Express middleware with optional permission check
  webAuthMiddleware(requiredPermission: string | null = null): AuthMiddleware {
    const webAuth = this.config.auth.web;
    if (!webAuth.enabled) {
      // Auth disabled: set user to the admin user from config
      const adminUser = webAuth?.username || 'admin';
      return (req, res, next) => {
        req.user = adminUser;
        req.role = 'admin';
        next();
      };
    }

    return (req: AuthWebRequest, res: Response, next: NextFunction) => {
      let token: string | null = null;
      const rawAuth = req.headers.authorization;
      const authHeader = typeof rawAuth === 'string' ? rawAuth : null;
      if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
      if (!token && req.cookies && req.cookies.token) token = req.cookies.token;

      if (!token) {
        // Public endpoints that don't require auth
        // /metrics carries the whole registry (topology, client ids, traffic), so it
        // is token-free only for a LOOPBACK scraper; any other source must
        // authenticate. It used to be public for everyone (issue #117).
        const peer = (req as { socket?: { remoteAddress?: string } }).socket?.remoteAddress;
        const fromLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
        if (
          (req.path === '/metrics' && fromLoopback) ||
          req.path.startsWith('/public/') ||
          req.path === '/api/swagger.json' ||
          req.path === '/api/docs'
        ) {
          return next();
        }
        if (req.path.startsWith('/api/')) {
          res.status(401).json({ error: 'Unauthorized', message: 'Token required' });
          return;
        }
        if (req.path !== '/login' && !req.path.startsWith('/public/')) {
          res.redirect('/login');
          return;
        }
        return next();
      }

      const result = this.verifyWebToken(token);
      if (!result.valid) {
        if (req.path.startsWith('/api/')) {
          res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
        } else {
          res.redirect('/login');
        }
        return;
      }

      // A token lives for 24h and carries a role snapshot, so the user store has to be
      // consulted on EVERY request: otherwise disabling or deleting an account left its
      // already-issued tokens working until they expired (issue #117). Same idiom as
      // hasPermission: missing user or enabled === false means no access.
      // result.username is optional in the payload type; narrow it before the lookup.
      const liveUsername = result.username;
      if (!liveUsername) {
        if (req.path.startsWith('/api/')) {
          res.status(401).json({ error: 'Unauthorized', message: 'Account is disabled or no longer exists' });
        } else {
          res.redirect('/login');
        }
        return;
      }
      const liveUser = this.users.get(liveUsername);
      if (!liveUser || !liveUser.enabled) {
        if (req.path.startsWith('/api/')) {
          res.status(401).json({ error: 'Unauthorized', message: 'Account is disabled or no longer exists' });
        } else {
          res.redirect('/login');
        }
        return;
      }
      req.user = result.username;
      req.role = result.role;

      // Check permission if required
      if (requiredPermission && !this.hasPermission(result.username || '', requiredPermission)) {
        if (req.path.startsWith('/api/')) {
          res.status(403).json({ error: 'Forbidden', message: `Permission denied: ${requiredPermission}` });
        } else {
          res.status(403).send('Forbidden');
        }
        return;
      }

      next();
    };
  }

  // ===========================================================================
  // Legacy: Client Node Authentication
  // ===========================================================================
  validateClientToken(token: string): boolean {
    return safeEqual(token, this.config.auth.token);
  }

  // ===========================================================================
  // Legacy: HTTP Proxy Auth + multi-password routing (issue #53)
  // ===========================================================================
  // A proxy credential either matches the legacy config pair (username AND
  // password, default pool with the global routing strategy), a panel-managed
  // extra password (any username; carries an optional tag/group filter, a
  // forced node UUID and a per-password strategy), or a connected node's UUID
  // used directly as the password (forced single node).
  resolveProxyAuth(
    authHeader: string | string[] | null | undefined
  ): { ok: boolean; route?: ProxyRoute } {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return { ok: true, route: {} };
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!header) return { ok: false };
    try {
      const parts = header.split(' ');
      if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic') return { ok: false };
      const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) return { ok: false };
      const username = decoded.substring(0, colonIdx);
      const password = decoded.substring(colonIdx + 1);
      return this._matchProxyCredentials(username, password);
    } catch (_) {
      return { ok: false };
    }
  }

  validateProxyAuth(authHeader: string | string[] | null | undefined): boolean {
    return this.resolveProxyAuth(authHeader).ok;
  }

  private _matchProxyCredentials(username: string, password: string): { ok: boolean; route?: ProxyRoute } {
    const proxyAuth = this.config.auth.proxy;
    // Legacy configured pair (strict username + password) -> default pool.
    if (username === proxyAuth.username && safeEqual(password, proxyAuth.password)) {
      return { ok: true, route: {} };
    }
    // Panel-managed extra passwords: only the password matters.
    if (this.proxyPasswordProvider) {
      for (const entry of this.proxyPasswordProvider()) {
        // Config-provided entries may hold either form; they are not rewritten here
    // because they come from configuration, not from the user store (issue #117).
    const matches = isBcryptHash(entry.password)
      ? bcrypt.compareSync(password, entry.password)
      : safeEqual(entry.password, password);
    if (entry.enabled && matches) {
          return {
            ok: true,
            route: {
              tag: entry.tag || null,
              clientId: entry.clientId || null,
              strategy: entry.strategy || null,
            },
          };
        }
      }
    }
    // A connected node UUID used directly as the password -> force that node.
    if (this.clientIdResolver) {
      const forcedId = this.clientIdResolver(password);
      if (forcedId) return { ok: true, route: { clientId: forcedId, strategy: null } };
    }
    return { ok: false };
  }

  generateProxyAuthHeader(): string | null {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return null;
    const encoded = Buffer.from(`${proxyAuth.username}:${proxyAuth.password}`).toString('base64');
    return `Basic ${encoded}`;
  }

  // SOCKS5 username/password auth (RFC 1929): returns the matched route so the
  // tunnel can honor per-password tag/strategy/UUID routing.
  resolveSocks5Auth(username: string, password: string): { ok: boolean; route?: ProxyRoute } {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return { ok: true, route: {} };
    return this._matchProxyCredentials(username, password);
  }

  validateSocks5Auth(username: string, password: string): boolean {
    return this.resolveSocks5Auth(username, password).ok;
  }
}
