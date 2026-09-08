// =============================================================================
// PluginManager - Hot-loadable plugin system
// Migrated to TypeScript (issue #42, Phase 2).
//
// NOTE: written in CJS-style TS on purpose - the plugin system relies on
// `require` + `require.cache` eviction for hot reload and on `__dirname` for
// its default plugin directory. Node type stripping loads this file as
// CommonJS (only the `export interface` type declarations below are erased);
// callers still use require('./lib/plugin-manager.ts').
// =============================================================================

'use strict';

// CJS-style TS file (require + require.cache + dynamic require are the point
// of the plugin hot-reload system) - disable the ESM-only require lint rule.
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require('path');
const fs = require('fs');

export interface PluginMeta {
  name?: string;
  version?: string;
  description?: string;
}

export type PluginHook = (context: unknown) => unknown;

export interface PluginHooks {
  onRequest?: PluginHook;
  onResponse?: PluginHook;
  onTunnel?: PluginHook;
  onClientConnect?: PluginHook;
  onClientDisconnect?: PluginHook;
  middleware?: PluginHook;
}

export interface PluginModule extends Partial<PluginHooks> {
  meta?: PluginMeta;
  init?: (ctx: Record<string, unknown>) => unknown;
  cleanup?: () => void;
}

export type PluginHookName = keyof PluginHooks;

const HOOK_NAMES: PluginHookName[] = [
  'onRequest',
  'onResponse',
  'onTunnel',
  'onClientConnect',
  'onClientDisconnect',
  'middleware',
];

interface LoadedPlugin {
  module: PluginModule;
  hooks: Partial<PluginHooks>;
  enabled: boolean;
  meta: PluginMeta;
  filePath: string;
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

export interface PluginSummary {
  name: string;
  enabled: boolean;
  version: string | undefined;
  description: string | undefined;
  hooks: PluginHookName[];
}

export interface HookExecutionResult {
  plugin: string;
  result?: unknown;
  error?: string;
}

class PluginManager {
  config: Record<string, unknown>;
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  private plugins: Map<string, LoadedPlugin> = new Map(); // name -> plugin
  pluginDir: string;

  constructor(config: Record<string, unknown>, logger: PluginManager['log']) {
    this.config = config;
    this.log = logger;
    const pluginsSection = config.plugins as { dir?: string } | undefined;
    this.pluginDir = pluginsSection?.dir || path.join(process.cwd(), 'plugins');
    this._loadAll();
  }

  private _loadAll() {
    const dir = this.pluginDir;
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {
        // ignore
      }
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
          const message = err instanceof Error ? err.message : String(err);
          this.log.error({ plugin: name, error: message }, 'Failed to load plugin');
        }
      }
    }
    if (count > 0) {
      this.log.info({ count, dir }, 'Plugins loaded');
    }
  }

  // Loads a plugin module. `filePath` is always produced by this manager from
  // the whitelisted plugin directory (never built from raw request input), so
  // the dynamic require below is safe from injection.
  private _loadPlugin(name: string, filePath: string) {
    // Clear from require cache for hot reload
    const absPath = path.resolve(filePath);
    for (const key of Object.keys(require.cache)) {
      if (key.toLowerCase() === absPath.toLowerCase()) {
        delete require.cache[key];
        break;
      }
    }
    const mod = require(absPath) as PluginModule;
    const meta: PluginMeta = mod.meta || { name, version: '0.0.0', description: '' };

    if (typeof mod.init !== 'function') {
      throw new Error('Plugin must export an init() function');
    }

    const hooks: Partial<PluginHooks> = {};
    for (const h of HOOK_NAMES) {
      if (typeof mod[h] === 'function') hooks[h] = mod[h] as PluginHook;
    }

    this.plugins.set(name, { module: mod, hooks, enabled: true, meta, filePath });
    this.log.info({ plugin: name, version: meta.version }, 'Plugin loaded');
  }

  // ===========================================================================
  // Plugin Lifecycle
  // ===========================================================================
  install(name: string, source: string): ActionResult {
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
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  uninstall(name: string): ActionResult {
    if (!this.plugins.has(name)) return { success: false, error: 'Plugin not found' };
    const plugin = this.plugins.get(name);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    // Call cleanup if available
    if (typeof plugin.module.cleanup === 'function') {
      try {
        plugin.module.cleanup();
      } catch (_) {
        // ignore
      }
    }
    this.plugins.delete(name);
    // Remove file
    try {
      fs.unlinkSync(plugin.filePath);
    } catch (_) {
      // ignore
    }
    this.log.info({ plugin: name }, 'Plugin uninstalled');
    return { success: true };
  }

  enable(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = true;
    return true;
  }

  disable(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = false;
    return true;
  }

  reload(name: string): ActionResult {
    const plugin = this.plugins.get(name);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    try {
      this._loadPlugin(name, plugin.filePath);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  list(): PluginSummary[] {
    const result: PluginSummary[] = [];
    for (const [name, plugin] of this.plugins) {
      result.push({
        name,
        enabled: plugin.enabled,
        version: plugin.meta.version,
        description: plugin.meta.description,
        hooks: Object.keys(plugin.hooks) as PluginHookName[],
      });
    }
    return result;
  }

  get(name: string): LoadedPlugin | null {
    return this.plugins.get(name) || null;
  }

  // ===========================================================================
  // Hook Execution
  // ===========================================================================
  async executeHook(hookName: PluginHookName, context: unknown): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];
    for (const [name, plugin] of this.plugins) {
      if (!plugin.enabled) continue;
      const hook = plugin.hooks[hookName];
      if (typeof hook === 'function') {
        try {
          const result = await hook(context);
          results.push({ plugin: name, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error({ plugin: name, hook: hookName, error: message }, 'Plugin hook error');
          results.push({ plugin: name, error: message });
        }
      }
    }
    return results;
  }

  destroy() {
    for (const plugin of this.plugins.values()) {
      if (typeof plugin.module.cleanup === 'function') {
        try {
          plugin.module.cleanup();
        } catch (_) {
          // ignore
        }
      }
    }
    this.plugins.clear();
  }
}

module.exports = { PluginManager };
