'use strict';

const fs = require('fs');
const path = require('path');
const { getEnvWithFallback } = require('./utils');

const SENSITIVE_ACTIONS = [
  'key.create',
  'key.revoke',
  'key.rotate',
  'key.update',
  'admin.login',
  'admin.config',
  'delegate'
];

// Match is substring-based (`key.toLowerCase().includes(token)`), so order the
// list longest-first when a name is a prefix of another (e.g. 'authorization'
// would otherwise also match any key containing 'auth'). The current set has
// no such prefixes, so lexicographic order is fine.
const SENSITIVE_PARAMS = [
  'authorization',
  'apiKey',
  'api_key',
  'cookie',
  'credential',
  'key',
  'password',
  'secret',
  'set-cookie',
  'token',
];

class AuditLogger {
  constructor(options = {}) {
    this.enabled = options.enabled !== undefined
      ? options.enabled
      : getEnvWithFallback('TRAECN_AUDIT_ENABLED', 'TRAE_AUDIT_ENABLED', '1') === '1';
    this.logDir = options.logDir || getEnvWithFallback('TRAECN_AUDIT_LOG_DIR', 'TRAE_AUDIT_LOG_DIR', './audit-logs');
    this.maxLogAge = options.maxLogAge || parseInt(getEnvWithFallback('TRAECN_AUDIT_MAX_AGE_DAYS', 'TRAE_AUDIT_MAX_AGE_DAYS', '30'), 10);
    this.maxLogSize = options.maxLogSize || parseInt(getEnvWithFallback('TRAECN_AUDIT_MAX_SIZE_MB', 'TRAE_AUDIT_MAX_SIZE_MB', '100'), 10);
    this.logs = [];
    this._logFile = null;
    this._init();
  }

  _init() {
    if (!this.enabled) return;
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      this._cleanupOldLogs();
    } catch (e) {
      console.warn('[AuditLogger] Failed to initialize log directory:', e.message);
    }
  }

  _getLogFileName() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `audit-${date}.jsonl`);
  }

  _writeToFile(entry) {
    if (!this.enabled) return;
    try {
      const filePath = this._getLogFileName();
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(filePath, line, 'utf8');
    } catch (e) {
      console.warn('[AuditLogger] Failed to write to log file:', e.message);
    }
  }

  _cleanupOldLogs() {
    if (!this.maxLogAge) return;
    try {
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAgeMs = this.maxLogAge * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.startsWith('audit-') || !file.endsWith('.jsonl')) continue;
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      console.warn('[AuditLogger] Failed to cleanup old logs:', e.message);
    }
  }

  _sanitizeParams(params) {
    if (!params || typeof params !== 'object') return params;
    const sanitized = {};
    for (const [key, value] of Object.entries(params)) {
      if (SENSITIVE_PARAMS.some(s => key.toLowerCase().includes(s))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this._sanitizeParams(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  _extractIP(req) {
    if (!req || !req.headers) return 'unknown';
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  _extractUser(req, keyId) {
    if (keyId) return { type: 'api_key', id: keyId };
    if (!req || !req.headers) return { type: 'anonymous', id: null };
    const user = req.headers['x-user-id'];
    if (user) return { type: 'user', id: user };
    return { type: 'anonymous', id: null };
  }

  log(options) {
    if (!this.enabled) return;

    const entry = {
      timestamp: options.timestamp || new Date().toISOString(),
      id: options.id || 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      action: options.action,
      resource: options.resource || null,
      user: options.user || this._extractUser(options.req || {}, options.keyId),
      keyId: options.keyId || null,
      ip: options.ip || (options.req ? this._extractIP(options.req) : 'unknown'),
      method: options.method || (options.req ? options.req.method : null),
      path: options.path || (options.req ? options.req.url : null),
      params: options.params ? this._sanitizeParams(options.params) : null,
      result: options.result || null,
      status: options.status || 'success',
      error: options.error || null,
      metadata: options.metadata || null
    };

    this.logs.push(entry);

    if (SENSITIVE_ACTIONS.includes(options.action)) {
      this._writeToFile(entry);
    }

    return entry;
  }

  logRequest(req, options = {}) {
    return this.log({
      req,
      action: options.action || 'http.request',
      resource: options.resource || req.url,
      params: options.params,
      status: options.status || 'success',
      metadata: options.metadata
    });
  }

  logKeyCreate(keyId, req) {
    return this.log({
      req,
      action: 'key.create',
      resource: `/api/keys`,
      keyId,
      metadata: { operation: 'create' }
    });
  }

  logKeyRevoke(keyId, req) {
    return this.log({
      req,
      action: 'key.revoke',
      resource: `/api/keys/${keyId}`,
      keyId,
      status: 'success',
      metadata: { operation: 'revoke' }
    });
  }

  logKeyRotate(keyId, req) {
    return this.log({
      req,
      action: 'key.rotate',
      resource: `/api/keys/${keyId}/rotate`,
      keyId,
      metadata: { operation: 'rotate' }
    });
  }

  logAuthFailure(req, reason) {
    return this.log({
      req,
      action: 'auth.failure',
      resource: req.url,
      status: 'failure',
      error: reason,
      metadata: { reason }
    });
  }

  query(options = {}) {
    let results = [...this.logs];

    if (options.action) {
      results = results.filter(log => log.action === options.action);
    }
    if (options.userId) {
      results = results.filter(log => log.user?.id === options.userId);
    }
    if (options.keyId) {
      results = results.filter(log => log.keyId === options.keyId);
    }
    if (options.ip) {
      results = results.filter(log => log.ip === options.ip);
    }
    if (options.status) {
      results = results.filter(log => log.status === options.status);
    }
    if (options.startDate) {
      const start = new Date(options.startDate);
      results = results.filter(log => new Date(log.timestamp) >= start);
    }
    if (options.endDate) {
      const end = new Date(options.endDate);
      results = results.filter(log => new Date(log.timestamp) <= end);
    }
    if (options.resource) {
      results = results.filter(log => log.resource?.includes(options.resource));
    }

    const limit = options.limit || 100;
    const offset = options.offset || 0;

    results = results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      logs: results.slice(offset, offset + limit),
      total: results.length,
      offset,
      limit
    };
  }

  exportToJSON(options = {}) {
    const { logs } = this.query(options);
    return JSON.stringify(logs, null, 2);
  }

  exportToCSV(options = {}) {
    const { logs } = this.query({ ...options, limit: 10000 });
    const headers = ['timestamp', 'id', 'action', 'resource', 'user', 'ip', 'method', 'path', 'status', 'error'];
    const rows = logs.map(log => [
      log.timestamp,
      log.id,
      log.action,
      log.resource || '',
      JSON.stringify(log.user || {}),
      log.ip,
      log.method || '',
      log.path || '',
      log.status,
      log.error || ''
    ].map(v => {
      const str = String(v);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  getStats() {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const recentLogs = this.logs.filter(log => new Date(log.timestamp).getTime() > oneDayAgo);
    const weeklyLogs = this.logs.filter(log => new Date(log.timestamp).getTime() > oneWeekAgo);

    const actionCounts = {};
    for (const log of this.logs) {
      actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
    }

    const statusCounts = { success: 0, failure: 0 };
    for (const log of this.logs) {
      if (log.status === 'success' || log.status === 'success') {
        statusCounts.success++;
      } else {
        statusCounts.failure++;
      }
    }

    return {
      totalLogs: this.logs.length,
      last24Hours: recentLogs.length,
      last7Days: weeklyLogs.length,
      actionCounts,
      statusCounts
    };
  }

  clear() {
    this.logs = [];
  }
}

module.exports = { AuditLogger };
