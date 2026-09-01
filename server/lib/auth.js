// =============================================================================
// Auth v3.0 - Multi-user authentication with RBAC (Role-Based Access Control)
// =============================================================================
'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Built-in roles with permission sets
const ROLES = {
  admin: {
    permissions: [
      'client:list', 'client:kick', 'client:tag', 'client:weight',
      'client:bandwidth', 'client:events',
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
      'client:bandwidth', 'client:events',
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

class AuthManager {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.jwtSecret = config.auth.web?.jwt_secret || crypto.randomBytes(32).toString('hex');
    this.users = new Map(); // username -> { password, role, enabled, createdAt }
    this._initUsers();
  }

  _initUsers() {
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
        password: u.password,
        role: u.role || 'viewer',
        enabled: u.enabled !== false,
        createdAt: Date.now(),
      });
    }
  }

  // ===========================================================================
  // User Management
  // ===========================================================================
  listUsers() {
    const result = [];
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

  addUser(username, password, role = 'viewer') {
    if (this.users.has(username)) return false;
    if (!['admin', 'operator', 'viewer'].includes(role)) return false;
    this.users.set(username, { password, role, enabled: true, createdAt: Date.now() });
    return true;
  }

  deleteUser(username) {
    // Cannot delete the last admin
    const adminCount = this.listUsers().filter(u => u.role === 'admin').length;
    const user = this.users.get(username);
    if (user && user.role === 'admin' && adminCount <= 1) return false;
    return this.users.delete(username);
  }

  modifyUser(username, updates) {
    const user = this.users.get(username);
    if (!user) return false;
    if (updates.password) user.password = updates.password;
    if (updates.role && ['admin', 'operator', 'viewer'].includes(updates.role)) user.role = updates.role;
    if (updates.enabled !== undefined) user.enabled = updates.enabled;
    return true;
  }

  getRole(username) {
    const user = this.users.get(username);
    return user ? user.role : null;
  }

  // ===========================================================================
  // Permission Check
  // ===========================================================================
  hasPermission(username, permission) {
    const user = this.users.get(username);
    if (!user || !user.enabled) return false;
    const role = ROLES[user.role];
    if (!role) return false;
    return role.permissions.includes(permission);
  }

  getPermissions(username) {
    const user = this.users.get(username);
    if (!user || !user.enabled) return [];
    const role = ROLES[user.role];
    return role ? [...role.permissions] : [];
  }

  // ===========================================================================
  // Web Panel Authentication (JWT)
  // ===========================================================================
  validateWebLogin(username, password) {
    const webAuth = this.config.auth.web;
    if (!webAuth.enabled) return true;
    const user = this.users.get(username);
    if (!user || !user.enabled) return false;
    return user.password === password;
  }

  generateWebToken(username) {
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

  verifyWebToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      return { valid: true, username: payload.sub, role: payload.role };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  // Express middleware with optional permission check
  webAuthMiddleware(requiredPermission = null) {
    const webAuth = this.config.auth.web;
    if (!webAuth.enabled) {
      // Auth disabled: set user to the admin user from config
      const adminUser = webAuth?.username || 'admin';
      return (req, res, next) => { req.user = adminUser; req.role = 'admin'; next(); };
    }

    return (req, res, next) => {
      let token = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
      if (!token && req.cookies && req.cookies.token) token = req.cookies.token;

      if (!token) {
        // Public endpoints that don't require auth
        if (req.path === '/metrics' || req.path.startsWith('/public/') || req.path === '/api/swagger.json' || req.path === '/api/docs') {
          return next();
        }
        if (req.path.startsWith('/api/')) {
          return res.status(401).json({ error: 'Unauthorized', message: 'Token required' });
        }
        if (req.path !== '/login' && !req.path.startsWith('/public/')) return res.redirect('/login');
        return next();
      }

      const result = this.verifyWebToken(token);
      if (!result.valid) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
        return res.redirect('/login');
      }

      req.user = result.username;
      req.role = result.role;

      // Check permission if required
      if (requiredPermission && !this.hasPermission(result.username, requiredPermission)) {
        if (req.path.startsWith('/api/')) {
          return res.status(403).json({ error: 'Forbidden', message: `Permission denied: ${requiredPermission}` });
        }
        return res.status(403).send('Forbidden');
      }

      next();
    };
  }

  // ===========================================================================
  // Legacy: Client Node Authentication
  // ===========================================================================
  validateClientToken(token) {
    return token === this.config.auth.token;
  }

  // ===========================================================================
  // Legacy: HTTP Proxy Auth
  // ===========================================================================
  validateProxyAuth(authHeader) {
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

  generateProxyAuthHeader() {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return null;
    const encoded = Buffer.from(`${proxyAuth.username}:${proxyAuth.password}`).toString('base64');
    return `Basic ${encoded}`;
  }

  validateSocks5Auth(username, password) {
    const proxyAuth = this.config.auth.proxy;
    if (!proxyAuth.enabled) return true;
    return username === proxyAuth.username && password === proxyAuth.password;
  }
}

module.exports = { AuthManager, ROLES };