'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secretVault = require('./secret-vault');
const { sanitizeLog } = require('./utils');

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
  server: {
    host: {
      type: 'string',
      default: '127.0.0.1',
      description: 'Gateway server listen host'
    },
    port: {
      type: 'number',
      min: 1024,
      max: 65535,
      default: 8788,
      description: 'Gateway server listen port'
    },
    token: {
      type: 'string',
      default: '',
      description: 'API authentication token'
    },
    authHeader: {
      type: 'string',
      default: 'Authorization',
      description: 'Authentication HTTP header name'
    }
  },
  traeControl: {
    autoStart: {
      type: 'boolean',
      default: false,
      description: 'Whether to auto-start the Trae process'
    },
    recoveryCooldownMs: {
      type: 'number',
      min: 5000,
      max: 300000,
      default: 30000,
      description: 'Trae recovery cooldown in milliseconds'
    },
    recoveryWaitMs: {
      type: 'number',
      min: 10000,
      max: 600000,
      default: 60000,
      description: 'Trae recovery wait timeout in milliseconds'
    }
  },
  autoRecover: {
    enabled: {
      type: 'boolean',
      default: false,
      description: 'Enable automatic CDP recovery'
    },
    probeIntervalMs: {
      type: 'number',
      min: 5000,
      max: 300000,
      default: 30000,
      description: 'Health probe interval in milliseconds'
    },
    maxRecoveries: {
      type: 'number',
      min: 1,
      max: 20,
      default: 5,
      description: 'Maximum recovery attempts'
    },
    probeTimeoutMs: {
      type: 'number',
      min: 1000,
      max: 30000,
      default: 5000,
      description: 'Health probe timeout in milliseconds'
    }
  },
  queue: {
    flickerGraceMs: {
      type: 'number',
      min: 10000,
      max: 300000,
      default: 45000,
      description: 'Queue status flicker grace period in milliseconds'
    },
    persistencePath: {
      type: 'string',
      default: '',
      description: 'Queue persistence file path (empty = OS default)'
    }
  },
  features: {
    debugEndpoints: {
      type: 'boolean',
      default: false,
      description: 'Enable debug endpoints'
    },
    mockBridge: {
      type: 'boolean',
      default: false,
      description: 'Enable mock bridge mode'
    },
    enforceOperationConfirmation: {
      type: 'boolean',
      default: false,
      description: 'Enforce operation confirmation'
    }
  },
  plugins: {
    type: 'object',
    default: {},
    description: 'Plugin enable/disable settings',
    additionalProperties: {
      type: 'boolean'
    }
  },
  secrets: {
    type: 'object',
    default: {},
    description: 'Sensitive values (API keys, tokens). Always encrypted at rest when a passphrase is configured.',
    additionalProperties: { type: 'string' }
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
  server: {
    host: '127.0.0.1',
    port: 8788,
    token: '',
    authHeader: 'Authorization'
  },
  traeControl: {
    autoStart: false,
    recoveryCooldownMs: 30000,
    recoveryWaitMs: 60000
  },
  autoRecover: {
    enabled: false,
    probeIntervalMs: 30000,
    maxRecoveries: 5,
    probeTimeoutMs: 5000
  },
  queue: {
    flickerGraceMs: 45000,
    persistencePath: ''
  },
  features: {
    debugEndpoints: false,
    mockBridge: false,
    enforceOperationConfirmation: false
  },
  plugins: {},
  secrets: {}
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
    // The passphrase used to encrypt/decrypt the `secrets` section. If
    // unset, the secrets section is stored as plaintext (still better than
    // a hard-coded key — operators are expected to set this in production).
    this.encryptionPassphrase = options.encryptionPassphrase
      || process.env.TRAECN_CONFIG_ENCRYPTION_KEY
      || process.env.TRAE_CONFIG_ENCRYPTION_KEY
      || '';

    this._config = this._deepClone(DEFAULT_CONFIG);
    this._history = [];
    this._historyIndex = -1;
    this._watcher = null;
    this._auditLog = [];
    this._auditId = 0;

    // Load from config file first (lowest priority among explicit sources).
    if (this.configFile) {
      this._loadFromFile();
    }

    // Then apply env-var overrides (env vars take precedence over file).
    this._applyEnvOverrides();

    if (this.watchEnabled) {
      this._startWatching();
    }
  }

  /**
   * Apply environment-variable overrides on top of the file-loaded config.
   * Each mapping entry describes: configPath -> [envVarNames], transformer.
   * Env vars are checked in order; the first defined one wins.
   */
  _applyEnvOverrides() {
    const mappings = [
      // Server
      { path: 'server.host', env: ['TRAECN_HOST', 'HOST', 'TRAE_HOST'] },
      { path: 'server.port', env: ['TRAECN_PORT', 'PORT', 'TRAE_PORT'], transform: (v) => parseInt(v, 10) },
      { path: 'server.token', env: ['TRAECN_GATEWAY_TOKEN', 'TRAE_GATEWAY_TOKEN'] },
      { path: 'server.authHeader', env: ['TRAECN_AUTH_HEADER', 'TRAE_AUTH_HEADER'] },
      // CORS
      { path: 'cors.allowedOrigins', env: ['TRAECN_ALLOWED_ORIGINS', 'TRAE_ALLOWED_ORIGINS'] },
      // Trae control
      { path: 'traeControl.autoStart', env: ['TRAECN_AUTO_START_TRAE', 'TRAE_AUTO_START_TRAE'], transform: (v) => v !== '0' },
      { path: 'traeControl.recoveryCooldownMs', env: ['TRAECN_TRAE_RECOVERY_COOLDOWN_MS', 'TRAE_TRAE_RECOVERY_COOLDOWN_MS'], transform: (v) => parseInt(v, 10) },
      { path: 'traeControl.recoveryWaitMs', env: ['TRAECN_TRAE_RECOVERY_WAIT_MS', 'TRAE_TRAE_RECOVERY_WAIT_MS'], transform: (v) => parseInt(v, 10) },
      // Auto recover
      { path: 'autoRecover.enabled', env: ['TRAECN_AUTO_RECOVER', 'TRAE_AUTO_RECOVER'], transform: (v) => v === '1' },
      { path: 'autoRecover.probeIntervalMs', env: ['TRAECN_AUTO_RECOVER_PROBE_MS', 'TRAE_AUTO_RECOVER_PROBE_MS'], transform: (v) => parseInt(v, 10) },
      { path: 'autoRecover.maxRecoveries', env: ['TRAECN_AUTO_RECOVER_MAX', 'TRAE_AUTO_RECOVER_MAX'], transform: (v) => parseInt(v, 10) },
      { path: 'autoRecover.probeTimeoutMs', env: ['TRAECN_AUTO_RECOVER_PROBE_TIMEOUT_MS', 'TRAE_AUTO_RECOVER_PROBE_TIMEOUT_MS'], transform: (v) => parseInt(v, 10) },
      // Queue
      { path: 'queue.flickerGraceMs', env: ['TRAECN_QUEUE_FLICKER_GRACE_MS', 'TRAE_QUEUE_FLICKER_GRACE_MS'], transform: (v) => parseInt(v, 10) },
      { path: 'queue.persistencePath', env: ['TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH', 'TRAE_ACTIVE_QUEUE_PERSISTENCE_PATH'] },
      // Features
      { path: 'features.debugEndpoints', env: ['TRAECN_ENABLE_DEBUG_ENDPOINTS', 'TRAE_ENABLE_DEBUG_ENDPOINTS'], transform: (v) => v === '1' },
      { path: 'features.mockBridge', env: ['TRAECN_ENABLE_MOCK_BRIDGE', 'TRAE_ENABLE_MOCK_BRIDGE'], transform: (v) => v === '1' },
      { path: 'features.enforceOperationConfirmation', env: ['TRAECN_ENFORCE_OPERATION_CONFIRMATION', 'TRAE_ENFORCE_OPERATION_CONFIRMATION'], transform: (v) => v === '1' },
      // Rate limit
      { path: 'rateLimit.windowMs', env: ['TRAECN_RATE_LIMIT_WINDOW_MS', 'TRAE_RATE_LIMIT_WINDOW_MS'], transform: (v) => parseInt(v, 10) },
      { path: 'rateLimit.maxRequests', env: ['TRAECN_RATE_LIMIT_MAX_REQUESTS', 'TRAE_RATE_LIMIT_MAX_REQUESTS'], transform: (v) => parseInt(v, 10) },
    ];

    for (const { path: configPath, env: envNames, transform } of mappings) {
      let rawValue;
      let found = false;
      for (const name of envNames) {
        if (process.env[name] !== undefined) {
          rawValue = process.env[name];
          found = true;
          break;
        }
      }
      if (!found) continue;
      const value = transform ? transform(rawValue) : rawValue;
      this._setNestedValue(configPath, value);
    }
  }

  _setNestedValue(configPath, value) {
    const parts = configPath.split('.');
    let current = this._config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  _isEncryptionEnabled() {
    return Boolean(this.encryptionPassphrase);
  }

  _secretsOptions() {
    return { passphrase: this.encryptionPassphrase };
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
      // Decrypt any encrypted values back to plaintext for in-memory use.
      const decrypted = secretVault.decryptObject(parsed, this._secretsOptions());
      this._mergeConfig(decrypted, false);
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
      const decrypted = secretVault.decryptObject(parsed, this._secretsOptions());
      this._mergeConfig(decrypted, true);
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

    if (config.secrets !== undefined) {
      if (config.secrets === null || typeof config.secrets !== 'object' || Array.isArray(config.secrets)) {
        errors.push({
          path: 'secrets',
          message: 'secrets must be an object',
          current: typeof config.secrets
        });
      } else {
        for (const [secretKey, secretValue] of Object.entries(config.secrets)) {
          if (typeof secretValue !== 'string') {
            errors.push({
              path: `secrets.${secretKey}`,
              message: 'Secret value must be a string',
              current: typeof secretValue
            });
          } else if (secretValue.length > 4096) {
            errors.push({
              path: `secrets.${secretKey}`,
              message: 'Secret value exceeds 4096 characters',
              current: secretValue.length
            });
          }
        }
      }
    }

    // Server config validation
    if (config.server !== undefined && typeof config.server === 'object') {
      if (config.server.port !== undefined) {
        if (typeof config.server.port !== 'number') {
          errors.push({ path: 'server.port', message: 'Value must be a number', current: typeof config.server.port });
        } else if (config.server.port < 1024) {
          errors.push({ path: 'server.port', message: 'Value must be >= 1024', current: config.server.port, min: 1024 });
        } else if (config.server.port > 65535) {
          errors.push({ path: 'server.port', message: 'Value must be <= 65535', current: config.server.port, max: 65535 });
        }
      }
    }

    // TraeControl config validation
    if (config.traeControl !== undefined && typeof config.traeControl === 'object') {
      if (config.traeControl.autoStart !== undefined && typeof config.traeControl.autoStart !== 'boolean') {
        errors.push({ path: 'traeControl.autoStart', message: 'Value must be a boolean', current: typeof config.traeControl.autoStart });
      }
      if (config.traeControl.recoveryCooldownMs !== undefined) {
        if (typeof config.traeControl.recoveryCooldownMs !== 'number') {
          errors.push({ path: 'traeControl.recoveryCooldownMs', message: 'Value must be a number' });
        } else if (config.traeControl.recoveryCooldownMs < 5000 || config.traeControl.recoveryCooldownMs > 300000) {
          errors.push({ path: 'traeControl.recoveryCooldownMs', message: 'Value must be between 5000 and 300000', current: config.traeControl.recoveryCooldownMs });
        }
      }
      if (config.traeControl.recoveryWaitMs !== undefined) {
        if (typeof config.traeControl.recoveryWaitMs !== 'number') {
          errors.push({ path: 'traeControl.recoveryWaitMs', message: 'Value must be a number' });
        } else if (config.traeControl.recoveryWaitMs < 10000 || config.traeControl.recoveryWaitMs > 600000) {
          errors.push({ path: 'traeControl.recoveryWaitMs', message: 'Value must be between 10000 and 600000', current: config.traeControl.recoveryWaitMs });
        }
      }
    }

    // AutoRecover config validation
    if (config.autoRecover !== undefined && typeof config.autoRecover === 'object') {
      if (config.autoRecover.enabled !== undefined && typeof config.autoRecover.enabled !== 'boolean') {
        errors.push({ path: 'autoRecover.enabled', message: 'Value must be a boolean' });
      }
      if (config.autoRecover.probeIntervalMs !== undefined) {
        if (typeof config.autoRecover.probeIntervalMs !== 'number' || config.autoRecover.probeIntervalMs < 5000 || config.autoRecover.probeIntervalMs > 300000) {
          errors.push({ path: 'autoRecover.probeIntervalMs', message: 'Value must be a number between 5000 and 300000' });
        }
      }
      if (config.autoRecover.maxRecoveries !== undefined) {
        if (typeof config.autoRecover.maxRecoveries !== 'number' || config.autoRecover.maxRecoveries < 1 || config.autoRecover.maxRecoveries > 20) {
          errors.push({ path: 'autoRecover.maxRecoveries', message: 'Value must be a number between 1 and 20' });
        }
      }
      if (config.autoRecover.probeTimeoutMs !== undefined) {
        if (typeof config.autoRecover.probeTimeoutMs !== 'number' || config.autoRecover.probeTimeoutMs < 1000 || config.autoRecover.probeTimeoutMs > 30000) {
          errors.push({ path: 'autoRecover.probeTimeoutMs', message: 'Value must be a number between 1000 and 30000' });
        }
      }
    }

    // Queue config validation
    if (config.queue !== undefined && typeof config.queue === 'object') {
      if (config.queue.flickerGraceMs !== undefined) {
        if (typeof config.queue.flickerGraceMs !== 'number' || config.queue.flickerGraceMs < 10000 || config.queue.flickerGraceMs > 300000) {
          errors.push({ path: 'queue.flickerGraceMs', message: 'Value must be a number between 10000 and 300000' });
        }
      }
    }

    // Features config validation
    if (config.features !== undefined && typeof config.features === 'object') {
      for (const [featKey, featValue] of Object.entries(config.features)) {
        if (typeof featValue !== 'boolean') {
          errors.push({ path: `features.${featKey}`, message: 'Feature flag must be a boolean' });
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
    const sanitizedChanges = sanitizeLog(changes);
    const entry = {
      id: ++this._auditId,
      timestamp: new Date().toISOString(),
      action,
      changes: sanitizedChanges,
      source,
      hash: crypto.randomBytes(8).toString('hex')
    };
    this._auditLog.push(entry);

    if (this._auditLog.length > 1000) {
      this._auditLog.shift();
    }

    console.log(`[ConfigManager] Audit: ${action}`, JSON.stringify(sanitizedChanges));
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
      // Encrypt sensitive values before writing to disk. With no passphrase
      // configured we still pass through (single-user dev setups) so the
      // file remains editable by hand.
      const persisted = this._isEncryptionEnabled()
        ? secretVault.encryptObject(this._config, this._secretsOptions())
        : this._config;
      fs.writeFileSync(this.configFile, JSON.stringify(persisted, null, 2), 'utf8');
    } catch (err) {
      console.error('[ConfigManager] Failed to save config file:', err.message);
    }
  }

  reset() {
    const previousConfig = this._deepClone(this._config);
    this._config = this._deepClone(DEFAULT_CONFIG);

    // Deep clone the new config so the history entry is insulated from
    // future mutations via this._config (update() reassigns keys on this._config,
    // which would otherwise corrupt the stored "newConfig" reference).
    this._addHistory(previousConfig, this._deepClone(this._config), 'reset');
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

  /**
   * Return a single secret value from the encrypted-at-rest `secrets` block.
   * Returns null if the key is not set or the value is not a non-empty string.
   */
  getSecret(name) {
    if (!name || typeof name !== 'string') return null;
    const value = this._config.secrets?.[name];
    if (typeof value !== 'string' || value.length === 0) return null;
    return value;
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
