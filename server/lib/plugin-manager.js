// =============================================================================
// PluginManager - Hot-loadable plugin system
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');

class PluginManager {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.plugins = new Map(); // name -> { module, hooks, enabled, meta }
    this.pluginDir = config.plugins?.dir || path.join(__dirname, '..', 'plugins');
    this._loadAll();
  }

  _loadAll() {
    const dir = this.pluginDir;
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        const name = entry.name.replace(/\.(js|mjs)$/, '');
        try {
          this._loadPlugin(name, path.join(dir, entry.name));
          count++;
        } catch (err) {
          this.log.error({ plugin: name, error: err.message }, 'Failed to load plugin');
        }
      }
    }
    if (count > 0) {
      this.log.info({ count, dir }, 'Plugins loaded');
    }
  }

  _loadPlugin(name, filePath) {
    // Clear from require cache for hot reload
    const absPath = path.resolve(filePath);
    for (const key of Object.keys(require.cache)) {
      if (key.toLowerCase() === absPath.toLowerCase()) {
        delete require.cache[key];
        break;
      }
    }
    const mod = require(absPath);
    const meta = mod.meta || { name, version: '0.0.0', description: '' };

    if (typeof mod.init !== 'function') {
      throw new Error('Plugin must export an init() function');
    }

    const hooks = {};
    const hookNames = ['onRequest', 'onResponse', 'onTunnel', 'onClientConnect', 'onClientDisconnect', 'middleware'];
    for (const h of hookNames) {
      if (typeof mod[h] === 'function') hooks[h] = mod[h];
    }

    this.plugins.set(name, { module: mod, hooks, enabled: true, meta, filePath });
    this.log.info({ plugin: name, version: meta.version }, 'Plugin loaded');
  }

  // ===========================================================================
  // Plugin Lifecycle
  // ===========================================================================
  install(name, source) {
    // source could be a file path, npm package name, or URL
    if (this.plugins.has(name)) return { success: false, error: 'Plugin already installed' };

    const filePath = path.resolve(this.pluginDir, `${name}.js`);
    try {
      // If source is a file path, copy it
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, filePath);
      } else {
        // Write source as the plugin content
        fs.writeFileSync(filePath, source);
      }
      this._loadPlugin(name, filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  uninstall(name) {
    if (!this.plugins.has(name)) return { success: false, error: 'Plugin not found' };
    const plugin = this.plugins.get(name);
    // Call cleanup if available
    if (typeof plugin.module.cleanup === 'function') {
      try { plugin.module.cleanup(); } catch (_) {}
    }
    this.plugins.delete(name);
    // Remove file
    try { fs.unlinkSync(plugin.filePath); } catch (_) {}
    this.log.info({ plugin: name }, 'Plugin uninstalled');
    return { success: true };
  }

  enable(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = true;
    return true;
  }

  disable(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = false;
    return true;
  }

  reload(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    try {
      this._loadPlugin(name, plugin.filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  list() {
    const result = [];
    for (const [name, plugin] of this.plugins) {
      result.push({
        name,
        enabled: plugin.enabled,
        version: plugin.meta.version,
        description: plugin.meta.description,
        hooks: Object.keys(plugin.hooks),
      });
    }
    return result;
  }

  get(name) {
    return this.plugins.get(name) || null;
  }

  // ===========================================================================
  // Hook Execution
  // ===========================================================================
  async executeHook(hookName, context) {
    const results = [];
    for (const [name, plugin] of this.plugins) {
      if (!plugin.enabled) continue;
      const hook = plugin.hooks[hookName];
      if (typeof hook === 'function') {
        try {
          const result = await hook(context);
          results.push({ plugin: name, result });
        } catch (err) {
          this.log.error({ plugin: name, hook: hookName, error: err.message }, 'Plugin hook error');
          results.push({ plugin: name, error: err.message });
        }
      }
    }
    return results;
  }

  destroy() {
    for (const [name, plugin] of this.plugins) {
      if (typeof plugin.module.cleanup === 'function') {
        try { plugin.module.cleanup(); } catch (_) {}
      }
    }
    this.plugins.clear();
  }
}

module.exports = { PluginManager };