'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeLog } = require('./logger');

function validatePlugin(plugin, name) {
  const errors = [];

  if (!name || typeof name !== 'string') {
    errors.push('Plugin name must be a non-empty string');
  }

  if (!plugin || typeof plugin !== 'object') {
    errors.push('Plugin must be an object');
    return errors;
  }

  if (!plugin.name || typeof plugin.name !== 'string') {
    errors.push('Plugin must have a name property (string)');
  }

  if (!plugin.version || typeof plugin.version !== 'string') {
    errors.push('Plugin must have a version property (string)');
  }

  if (plugin.hooks) {
    if (typeof plugin.hooks !== 'object') {
      errors.push('Plugin hooks must be an object');
    } else {
      const validHooks = ['beforeTask', 'afterTask', 'onError', 'onStartup', 'onShutdown'];
      for (const hook of validHooks) {
        if (hook in plugin.hooks && typeof plugin.hooks[hook] !== 'function') {
          errors.push(`Plugin hook "${hook}" must be a function`);
        }
      }
    }
  }

  if (plugin.middleware && typeof plugin.middleware !== 'function') {
    errors.push('Plugin middleware must be a function');
  }

  if (plugin.routes) {
    if (!Array.isArray(plugin.routes)) {
      errors.push('Plugin routes must be an array');
    } else {
      for (let i = 0; i < plugin.routes.length; i++) {
        const route = plugin.routes[i];
        if (!route.method || typeof route.method !== 'string') {
          errors.push(`Plugin route[${i}] must have a method property (string)`);
        }
        if (!route.path || typeof route.path !== 'string') {
          errors.push(`Plugin route[${i}] must have a path property (string)`);
        }
        if (!route.handler || typeof route.handler !== 'function') {
          errors.push(`Plugin route[${i}] must have a handler function`);
        }
      }
    }
  }

  return errors;
}

class PluginManager {
  constructor(options = {}) {
    this.plugins = new Map();
    this.hooks = {
      beforeTask: [],
      afterTask: [],
      onError: [],
      onStartup: [],
      onShutdown: []
    };
    this.middlewares = [];
    this.routes = [];
    this.logger = options.logger || console;
    this.enabledPlugins = this._parseEnabledPlugins(options.enabledPlugins);
    this.pluginDir = options.pluginDir || this._getDefaultPluginDir();
  }

  _parseEnabledPlugins(envValue) {
    if (!envValue) return null;
    if (envValue === '*') return null;
    return envValue.split(',').map(s => s.trim()).filter(Boolean);
  }

  _getDefaultPluginDir() {
    const pluginsDir = process.env.TRAECN_PLUGINS_DIR || process.env.TRAE_PLUGINS_DIR;
    if (pluginsDir) return pluginsDir;
    return path.join(process.cwd(), 'plugins');
  }

  async register(plugin, options = {}) {
    const name = plugin.name || options.name;
    if (!name) {
      throw new Error('Plugin must have a name');
    }

    const errors = validatePlugin(plugin, name);
    if (errors.length > 0) {
      throw new Error(`Invalid plugin "${name}": ${errors.join(', ')}`);
    }

    if (this.enabledPlugins !== null && !this.enabledPlugins.includes(name)) {
      this.logger.log(`[PluginManager] Skipping disabled plugin: ${name}`);
      return false;
    }

    if (this.plugins.has(name)) {
      this.logger.warn(`[PluginManager] Plugin "${name}" is already registered, skipping`);
      return false;
    }

    const pluginInstance = {
      ...plugin,
      _registeredAt: new Date().toISOString(),
      _enabled: true
    };

    this.plugins.set(name, pluginInstance);

    if (plugin.hooks) {
      for (const hookName of Object.keys(this.hooks)) {
        if (typeof plugin.hooks[hookName] === 'function') {
          this.hooks[hookName].push({
            plugin: name,
            handler: plugin.hooks[hookName]
          });
        }
      }
    }

    if (typeof plugin.middleware === 'function') {
      this.middlewares.push({
        plugin: name,
        handler: plugin.middleware
      });
    }

    if (Array.isArray(plugin.routes)) {
      for (const route of plugin.routes) {
        this.routes.push({
          plugin: name,
          method: route.method.toUpperCase(),
          path: route.path,
          handler: route.handler
        });
      }
    }

    this.logger.log(`[PluginManager] Registered plugin: ${name} v${plugin.version}`);
    return true;
  }

  async unregister(name) {
    if (!this.plugins.has(name)) {
      return false;
    }

    const plugin = this.plugins.get(name);
    this.plugins.delete(name);

    for (const hookName of Object.keys(this.hooks)) {
      this.hooks[hookName] = this.hooks[hookName].filter(h => h.plugin !== name);
    }

    this.middlewares = this.middlewares.filter(m => m.plugin !== name);
    this.routes = this.routes.filter(r => r.plugin !== name);

    this.logger.log(`[PluginManager] Unregistered plugin: ${name}`);
    return true;
  }

  async loadFromDirectory(dirPath) {
    const results = { loaded: [], failed: [] };

    if (!fs.existsSync(dirPath)) {
      this.logger.warn(`[PluginManager] Plugin directory does not exist: ${dirPath}`);
      return results;
    }

    let files;
    try {
      files = fs.readdirSync(dirPath);
    } catch (err) {
      this.logger.error(`[PluginManager] Failed to read plugin directory: ${err.message}`);
      return results;
    }

    for (const file of files) {
      if (!file.endsWith('-plugin.js') && !file.endsWith('.plugin.js')) {
        continue;
      }

      const pluginPath = path.join(dirPath, file);
      let pluginModule;

      try {
        delete require.cache[require.resolve(pluginPath)];
        pluginModule = require(pluginPath);
      } catch (err) {
        this.logger.error(`[PluginManager] Failed to load plugin "${file}": ${err.message}`);
        results.failed.push({ name: file, error: err.message });
        continue;
      }

      const plugin = pluginModule.default || pluginModule;
      if (!plugin || typeof plugin !== 'object') {
        this.logger.error(`[PluginManager] Plugin "${file}" does not export a valid plugin object`);
        results.failed.push({ name: file, error: 'Invalid plugin export' });
        continue;
      }

      try {
        await this.register(plugin);
        results.loaded.push(plugin.name || file);
      } catch (err) {
        this.logger.error(`[PluginManager] Failed to register plugin "${file}": ${err.message}`);
        results.failed.push({ name: file, error: err.message });
      }
    }

    return results;
  }

  async loadBuiltInPlugins() {
    const results = { loaded: [], failed: [] };

    const builtInPlugins = [
      { name: 'logging-plugin', module: require('../../plugins/logging-plugin') },
      { name: 'metrics-plugin', module: require('../../plugins/metrics-plugin') },
      { name: 'webhook-plugin', module: require('../../plugins/webhook-plugin') }
    ];

    for (const { name, module } of builtInPlugins) {
      if (this.enabledPlugins !== null && !this.enabledPlugins.includes(name)) {
        continue;
      }

      try {
        delete require.cache[require.resolve('../../plugins/' + name)];
      } catch {
      }

      const plugin = module.default || module;
      if (!plugin || typeof plugin !== 'object') {
        this.logger.warn(`[PluginManager] Built-in plugin "${name}" is not available`);
        continue;
      }

      try {
        await this.register(plugin);
        results.loaded.push(name);
      } catch (err) {
        this.logger.error(`[PluginManager] Failed to register built-in plugin "${name}": ${err.message}`);
        results.failed.push({ name, error: err.message });
      }
    }

    return results;
  }

  async onStartup(gateway) {
    for (const { plugin, handler } of this.hooks.onStartup) {
      try {
        await handler(gateway);
        this.logger.log(`[PluginManager] onStartup hook executed for plugin: ${plugin}`);
      } catch (err) {
        this.logger.error(`[PluginManager] onStartup hook failed for plugin "${plugin}": ${err.message}`);
      }
    }
  }

  async onShutdown(gateway) {
    for (const { plugin, handler } of this.hooks.onShutdown) {
      try {
        await handler(gateway);
        this.logger.log(`[PluginManager] onShutdown hook executed for plugin: ${plugin}`);
      } catch (err) {
        this.logger.error(`[PluginManager] onShutdown hook failed for plugin "${plugin}": ${err.message}`);
      }
    }
  }

  async beforeTask(ctx) {
    for (const { plugin, handler } of this.hooks.beforeTask) {
      try {
        ctx = await handler(ctx);
      } catch (err) {
        this.logger.error(`[PluginManager] beforeTask hook failed for plugin "${plugin}": ${err.message}`);
      }
    }
    return ctx;
  }

  async afterTask(ctx, result) {
    for (const { plugin, handler } of this.hooks.afterTask) {
      try {
        result = await handler(ctx, result);
      } catch (err) {
        this.logger.error(`[PluginManager] afterTask hook failed for plugin "${plugin}": ${err.message}`);
      }
    }
    return result;
  }

  async onError(ctx, error) {
    for (const { plugin, handler } of this.hooks.onError) {
      try {
        await handler(ctx, error);
      } catch (err) {
        this.logger.error(`[PluginManager] onError hook failed for plugin "${plugin}": ${err.message}`);
      }
    }
  }

  async runMiddlewares(ctx, finalHandler) {
    let index = 0;

    const next = async () => {
      if (index >= this.middlewares.length) {
        return finalHandler();
      }

      const { plugin, handler } = this.middlewares[index++];
      try {
        return await handler(ctx, next);
      } catch (err) {
        this.logger.error(`[PluginManager] Middleware failed for plugin "${plugin}": ${err.message}`);
        throw err;
      }
    };

    return next();
  }

  getPlugin(name) {
    return this.plugins.get(name) || null;
  }

  getPluginList() {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.name,
      version: p.version,
      registeredAt: p._registeredAt,
      enabled: p._enabled,
      hooks: p.hooks ? Object.keys(p.hooks) : [],
      hasMiddleware: typeof p.middleware === 'function',
      hasRoutes: Array.isArray(p.routes) && p.routes.length > 0
    }));
  }

  getRoutes() {
    return this.routes.map(r => ({
      plugin: r.plugin,
      method: r.method,
      path: r.path
    }));
  }

  async reload() {
    const pluginNames = Array.from(this.plugins.keys());

    for (const name of pluginNames) {
      await this.unregister(name);
    }

    const results = {
      plugins: [],
      errors: []
    };

    try {
      const dirResults = await this.loadFromDirectory(this.pluginDir);
      results.plugins = dirResults.loaded;
      results.errors = results.errors.concat(
        dirResults.failed.map(f => ({ plugin: f.name, error: f.error }))
      );
    } catch (err) {
      results.errors.push({ plugin: 'directory', error: err.message });
    }

    return results;
  }
}

function createPluginManager(options = {}) {
  return new PluginManager(options);
}

module.exports = {
  PluginManager,
  createPluginManager,
  validatePlugin,
  sanitizeLog
};
