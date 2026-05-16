'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];

const CONFIG_SCHEMA = {
  logLevel: {
    type: 'string',
    enum: LOG_LEVELS,
    default: 'info',
    description: 'Log level for the application'
  },
  rateLimit: {
    windowMs: {
      type: 'number',
      min: 1000,
      max: 600000,
      default: 60000,
      description: 'Rate limit window in milliseconds'
    },
    maxRequests: {
      type: 'number',
      min: 1,
      max: 10000,
      default: 60,
      description: 'Maximum requests per window'
    }
  },
  timeout: {
    request: {
      type: 'number',
      min: 5000,
      max: 600000,
      default: 120000,
      description: 'HTTP request timeout in milliseconds'
    },
    response: {
      type: 'number',
      min: 1000,
      max: 600000,
      default: 30000,
      description: 'Response collection timeout in milliseconds'
    }
  },
  cors: {
    allowedOrigins: {
      type: 'string',
      default: '',
      description: 'Comma-separated list of allowed origins, or empty for all'
    },
    enabled: {
      type: 'boolean',
      default: true,
      description: 'Enable CORS support'
    }
  },
  plugins: {
    type: 'object',
    default: {},
    description: 'Plugin enable/disable settings',
    additionalProperties: {
      type: 'boolean'
    }
  }
};

const DEFAULT_CONFIG = {
  logLevel: 'info',
  rateLimit: {
    windowMs: 60000,
    maxRequests: 60
  },
  timeout: {
    request: 120000,
    response: 30000
  },
  cors: {
    allowedOrigins: '',
    enabled: true
  },
  plugins: {}
};

class ConfigValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

class ConfigManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.configFile = options.configFile || process.env.TRAECN_CONFIG_FILE || null;
    this.watchEnabled = options.watchEnabled !== undefined
      ? options.watchEnabled
      : process.env.TRAECN_CONFIG_WATCH === '1';
    this.maxHistory = options.maxHistory || 50;

    this._config = this._deepClone(DEFAULT_CONFIG);
    this._history = [];
    this._historyIndex = -1;
    this._watcher = null;
    this._auditLog = [];
    this._auditId = 0;

    if (this.configFile) {
      this._loadFromFile();
    }

    if (this.watchEnabled) {
      this._startWatching();
    }
  }

  _deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  _loadFromFile() {
    try {
      if (!fs.existsSync(this.configFile)) {
        return;
      }
      const content = fs.readFileSync(this.configFile, 'utf8');
      const parsed = JSON.parse(content);
      this._mergeConfig(parsed, false);
    } catch (err) {
      console.error('[ConfigManager] Failed to load config file:', err.message);
    }
  }

  _startWatching() {
    if (!this.configFile) return;

    try {
      const dir = path.dirname(this.configFile);
      const basename = path.basename(this.configFile);

      this._watcher = fs.watch(dir, (eventType, filename) => {
        if (filename === basename && eventType === 'change') {
          this._onConfigFileChange();
        }
      });
    } catch (err) {
      console.error('[ConfigManager] Failed to start config file watching:', err.message);
    }
  }

  _onConfigFileChange() {
    console.log('[ConfigManager] Config file changed, reloading...');
    try {
      const content = fs.readFileSync(this.configFile, 'utf8');
      const parsed = JSON.parse(content);
      this._mergeConfig(parsed, true);
      this.emit('configFileChanged', this.getConfig());
    } catch (err) {
      console.error('[ConfigManager] Failed to reload config file:', err.message);
    }
  }

  _mergeConfig(newConfig, recordHistory = true) {
    const previousConfig = this._deepClone(this._config);

    for (const key of Object.keys(CONFIG_SCHEMA)) {
      if (newConfig[key] !== undefined) {
        if (typeof newConfig[key] === 'object' && newConfig[key] !== null && !Array.isArray(newConfig[key])) {
          this._config[key] = { ...this._config[key], ...newConfig[key] };
        } else {
          this._config[key] = newConfig[key];
        }
      }
    }

    if (recordHistory) {
      this._addHistory(previousConfig, this._deepClone(this._config), 'file-reload');
    }
  }

  validate(config) {
    const errors = [];

    if (config.logLevel !== undefined) {
      if (typeof config.logLevel !== 'string' || !LOG_LEVELS.includes(config.logLevel)) {
        errors.push({
          path: 'logLevel',
          message: `Value must be one of: ${LOG_LEVELS.join(', ')}`,
          current: config.logLevel
        });
      }
    }

    if (config.rateLimit !== undefined && typeof config.rateLimit === 'object') {
      if (config.rateLimit.windowMs !== undefined) {
        if (typeof config.rateLimit.windowMs !== 'number') {
          errors.push({ path: 'rateLimit.windowMs', message: 'Value must be a number', current: typeof config.rateLimit.windowMs });
        } else if (config.rateLimit.windowMs < 1000) {
          errors.push({ path: 'rateLimit.windowMs', message: 'Value must be >= 1000', current: config.rateLimit.windowMs, min: 1000 });
        } else if (config.rateLimit.windowMs > 600000) {
          errors.push({ path: 'rateLimit.windowMs', message: 'Value must be <= 600000', current: config.rateLimit.windowMs, max: 600000 });
        }
      }
      if (config.rateLimit.maxRequests !== undefined) {
        if (typeof config.rateLimit.maxRequests !== 'number') {
          errors.push({ path: 'rateLimit.maxRequests', message: 'Value must be a number', current: typeof config.rateLimit.maxRequests });
        } else if (config.rateLimit.maxRequests < 1) {
          errors.push({ path: 'rateLimit.maxRequests', message: 'Value must be >= 1', current: config.rateLimit.maxRequests, min: 1 });
        } else if (config.rateLimit.maxRequests > 10000) {
          errors.push({ path: 'rateLimit.maxRequests', message: 'Value must be <= 10000', current: config.rateLimit.maxRequests, max: 10000 });
        }
      }
    }

    if (config.timeout !== undefined && typeof config.timeout === 'object') {
      if (config.timeout.request !== undefined) {
        if (typeof config.timeout.request !== 'number') {
          errors.push({ path: 'timeout.request', message: 'Value must be a number', current: typeof config.timeout.request });
        } else if (config.timeout.request < 5000) {
          errors.push({ path: 'timeout.request', message: 'Value must be >= 5000', current: config.timeout.request, min: 5000 });
        } else if (config.timeout.request > 600000) {
          errors.push({ path: 'timeout.request', message: 'Value must be <= 600000', current: config.timeout.request, max: 600000 });
        }
      }
      if (config.timeout.response !== undefined) {
        if (typeof config.timeout.response !== 'number') {
          errors.push({ path: 'timeout.response', message: 'Value must be a number', current: typeof config.timeout.response });
        } else if (config.timeout.response < 1000) {
          errors.push({ path: 'timeout.response', message: 'Value must be >= 1000', current: config.timeout.response, min: 1000 });
        } else if (config.timeout.response > 600000) {
          errors.push({ path: 'timeout.response', message: 'Value must be <= 600000', current: config.timeout.response, max: 600000 });
        }
      }
    }

    if (config.cors !== undefined && typeof config.cors === 'object') {
      if (config.cors.enabled !== undefined && typeof config.cors.enabled !== 'boolean') {
        errors.push({ path: 'cors.enabled', message: 'Value must be a boolean', current: typeof config.cors.enabled });
      }
    }

    if (config.plugins !== undefined && typeof config.plugins === 'object') {
      for (const [pluginKey, pluginValue] of Object.entries(config.plugins)) {
        if (typeof pluginValue !== 'boolean') {
          errors.push({
            path: `plugins.${pluginKey}`,
            message: `Plugin value must be a boolean`,
            current: typeof pluginValue
          });
        }
      }
    }

    const dependencyErrors = this._checkDependencies(config);
    errors.push(...dependencyErrors);

    if (errors.length > 0) {
      throw new ConfigValidationError('Configuration validation failed', errors);
    }

    return true;
  }

  _checkDependencies(config) {
    const errors = [];

    if (config.rateLimit?.maxRequests && config.rateLimit?.windowMs) {
      const requestsPerSecond = config.rateLimit.maxRequests / (config.rateLimit.windowMs / 1000);
      if (requestsPerSecond > 100) {
        errors.push({
          path: 'rateLimit',
          message: 'Rate limit exceeds recommended 100 requests/second',
          current: requestsPerSecond
        });
      }
    }

    return errors;
  }

  _addHistory(previousConfig, newConfig, source) {
    if (this._historyIndex < this._history.length - 1) {
      this._history = this._history.slice(0, this._historyIndex + 1);
    }

    this._history.push({
      timestamp: new Date().toISOString(),
      previousConfig,
      newConfig,
      source
    });

    if (this._history.length > this.maxHistory) {
      this._history.shift();
    } else {
      this._historyIndex++;
    }
  }

  _logAudit(action, changes, source = 'api') {
    const entry = {
      id: ++this._auditId,
      timestamp: new Date().toISOString(),
      action,
      changes,
      source,
      hash: crypto.randomBytes(8).toString('hex')
    };
    this._auditLog.push(entry);

    if (this._auditLog.length > 1000) {
      this._auditLog.shift();
    }

    console.log(`[ConfigManager] Audit: ${action}`, JSON.stringify(changes));
  }

  update(updates, source = 'api') {
    const previousConfig = this._deepClone(this._config);

    this.validate(updates);

    const changes = {};
    for (const [key, value] of Object.entries(updates)) {
      if (JSON.stringify(this._config[key]) !== JSON.stringify(value)) {
        changes[key] = { previous: this._config[key], next: value };
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          this._config[key] = { ...this._config[key], ...value };
        } else {
          this._config[key] = value;
        }
      }
    }

    if (Object.keys(changes).length > 0) {
      this._addHistory(previousConfig, this._deepClone(this._config), source);
      this._logAudit('update', changes, source);
      this.emit('configChanged', { changes, config: this.getConfig() });
    }

    if (this.configFile) {
      this._saveToFile();
    }

    return {
      success: true,
      changes,
      config: this.getConfig()
    };
  }

  _saveToFile() {
    if (!this.configFile) return;

    try {
      const dir = path.dirname(this.configFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configFile, JSON.stringify(this._config, null, 2), 'utf8');
    } catch (err) {
      console.error('[ConfigManager] Failed to save config file:', err.message);
    }
  }

  reset() {
    const previousConfig = this._deepClone(this._config);
    this._config = this._deepClone(DEFAULT_CONFIG);

    this._addHistory(previousConfig, this._config, 'reset');
    this._logAudit('reset', { previous: previousConfig, defaults: DEFAULT_CONFIG }, 'api');

    this.emit('configChanged', { changes: { '*': { previous: previousConfig, next: this._config } }, config: this.getConfig() });

    if (this.configFile) {
      this._saveToFile();
    }

    return {
      success: true,
      config: this.getConfig()
    };
  }

  rollback(steps = 1) {
    if (this._history.length === 0 || steps < 1) {
      return {
        success: false,
        error: 'No history available for rollback'
      };
    }

    const targetRecordIndex = this._history.length - steps;
    if (targetRecordIndex < 0) {
      return {
        success: false,
        error: `Cannot rollback ${steps} steps. Available: ${this._history.length}`
      };
    }

    const targetRecord = this._history[targetRecordIndex];
    const previousConfig = this._deepClone(this._config);

    this._config = this._deepClone(targetRecord.previousConfig);

    this._history = this._history.slice(0, targetRecordIndex);
    this._historyIndex = this._history.length - 1;

    const changes = { previous: previousConfig, next: this._config };
    this._logAudit('rollback', { steps, changes }, 'api');
    this.emit('configChanged', { changes, config: this.getConfig() });

    if (this.configFile) {
      this._saveToFile();
    }

    return {
      success: true,
      steps,
      config: this.getConfig()
    };
  }

  getConfig() {
    return this._deepClone(this._config);
  }

  getSchema() {
    return CONFIG_SCHEMA;
  }

  getDiff(config1, config2 = this._config) {
    const diff = {};

    for (const key of Object.keys(CONFIG_SCHEMA)) {
      const val1 = config1[key];
      const val2 = config2[key];

      if (JSON.stringify(val1) !== JSON.stringify(val2)) {
        diff[key] = { previous: val1, current: val2 };
      }
    }

    return {
      hasDiff: Object.keys(diff).length > 0,
      diff,
      config1,
      config2
    };
  }

  getHistory() {
    return this._history.slice(0, this._historyIndex + 1);
  }

  getAuditLog() {
    return this._auditLog.slice();
  }

  applyToGateway(gateway) {
    const config = this._config;

    if (config.logLevel) {
      gateway.logLevel = config.logLevel;
    }

    if (config.rateLimit) {
      gateway.rateLimiter = new (require('./gateway').RateLimiter)(
        config.rateLimit.windowMs,
        config.rateLimit.maxRequests
      );
    }

    if (config.timeout) {
      gateway.requestTimeout = config.timeout.request;
    }

    if (config.cors) {
      gateway.allowedOrigins = config.cors.allowedOrigins;
      gateway.corsEnabled = config.cors.enabled;
    }

    if (config.plugins) {
      gateway.pluginSettings = { ...config.plugins };
    }
  }

  stopWatching() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }
}

function createConfigManager(options) {
  return new ConfigManager(options);
}

module.exports = {
  ConfigManager,
  ConfigValidationError,
  createConfigManager,
  CONFIG_SCHEMA,
  DEFAULT_CONFIG,
  LOG_LEVELS
};
