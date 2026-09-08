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

export type RoleName = 'admin' | 'operator' | 'viewer';

const VALID_ROLES: RoleName[] = ['admin', 'operator', 'viewer'];

function toRoleName(value: string | undefined): RoleName {
  if (value === 'admin' || value === 'operator' || value === 'viewer') return value;
  return 'viewer';
}

// Built-in roles with permission sets
export const ROLES: Record<RoleName, { permissions: string[] }> = {
  admin: {
    permissions: [
      'client:list', 'client:kick', 'client:tag', 'client:weight',
      'client:bandwidth', 'client:events', 'client:alias', 'client:notes', 'client:region',
      'proxy:config', 'proxy:stats',
      'routing:config', 'routing:strategy',
      'circuit:reset', 'circuit:view',
      'system:config', 'system:logs',
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
      'client:bandwidth', 'client:events', 'client:alias', 'client:notes', 'client:region',
      'proxy:stats',
      'routing:strategy',
      'circuit:reset', 'circuit:view',
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

export class AuthManager {
  config: ServerConfig;
  log: AppLogger;
  private jwtSecret: string;
  private users: Map<string, AuthUserValue> = new Map(); // username -> entry

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
    const adminCount = this.listUsers().filter((u) => u.role === 'admin').length;
    const user = this.users.get(username);
    if (user && user.role === 'admin' && adminCount <= 1) return false;
    return this.users.delete(username);
  }

  modifyUser(username: string, updates: { password?: string; role?: string; enabled?: boolean }): boolean {
    const user = this.users.get(username);
    if (!user) return false;
    if (updates.password) user.password = updates.password;
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
    return user.password === password;
  }

  generateWebToken(username: string): string {
    const user = this.users.get(username);
    const role = user ? user.role : 'viewer';
    const payload = {
      sub: username,
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    };
    return jwt.sign(payload, this.jwtSecret);
  }

  verifyWebToken(token: string): WebAuthResult {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      if (typeof payload === 'string') {
        return { valid: false, error: 'unexpected string payload' };
      }
      const role = typeof payload.role === 'string' ? payload.role : undefined;
      const username = typeof payload.sub === 'string' ? payload.sub : undefined;
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
        if (
          req.path === '/metrics' ||
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
    return token === this.config.auth.token;
  }

  // ===========================================================================
  // Legacy: HTTP Proxy Auth
  // ===========================================================================
  validateProxyAuth(authHeader: string | null | undefined): boolean {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return true;
    if (!authHeader) return false;
    try {
      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic') return false;
      const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) return false;
      const username = decoded.substring(0, colonIdx);
      const password = decoded.substring(colonIdx + 1);
      return username === proxyAuth.username && password === proxyAuth.password;
    } catch (_) {
      return false;
    }
  }

  generateProxyAuthHeader(): string | null {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return null;
    const encoded = Buffer.from(`${proxyAuth.username}:${proxyAuth.password}`).toString('base64');
    return `Basic ${encoded}`;
  }

  validateSocks5Auth(username: string, password: string): boolean {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return true;
    return username === proxyAuth.username && password === proxyAuth.password;
  }
}
