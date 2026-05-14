'use strict';

const fs = require('fs');
const path = require('path');
const { getEnvWithFallback } = require('./utils');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const SENSITIVE_KEYS = ['token', 'password', 'secret', 'credential', 'authorization'];

/**
 * 清除敏感信息
 */
function sanitizeLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const sanitized = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLog(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 格式化文本日志
 */
function formatText(logEntry) {
  const { timestamp, level, message, requestId, sessionId, duration, metadata } = logEntry;
  let text = `${timestamp} [${level.toUpperCase()}] ${message}`;
  if (requestId) text += ` [requestId=${requestId}]`;
  if (sessionId) text += ` [sessionId=${sessionId}]`;
  if (duration !== undefined) text += ` [duration=${duration}ms]`;
  if (metadata && Object.keys(metadata).length > 0) {
    text += ` ${JSON.stringify(metadata)}`;
  }
  return text;
}

/**
 * 格式化 JSON 日志
 */
function formatJson(logEntry) {
  return JSON.stringify(logEntry);
}

/**
 * 旋转文件写入器
 */
class RotatingFileWriter {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.maxSize = options.maxSize || 10 * 1024 * 1024;
    this.maxFiles = options.maxFiles || 5;
    this.currentFile = null;
    this.currentSize = 0;
    this.currentDate = null;
    this._init();
  }

  _init() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (e) {
      console.error('[Logger] Failed to create log directory:', e.message);
    }
    this._rotateByDate();
  }

  _getDateStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  _getFileName(dateStr) {
    return path.join(this.logDir, `app-${dateStr}.log`);
  }

  _rotateByDate() {
    const dateStr = this._getDateStr();
    if (dateStr === this.currentDate && this.currentFile) return;
    if (this.currentFile) {
      try { this.currentFile.end(); } catch { /* 忽略 */ }
    }
    this.currentDate = dateStr;
    this.currentFile = null;
    this.currentSize = 0;
  }

  _ensureFile() {
    this._rotateByDate();
    if (!this.currentFile) {
      const fileName = this._getFileName(this.currentDate);
      this.currentFile = fs.createWriteStream(fileName, { flags: 'a' });
      try {
        this.currentSize = fs.existsSync(fileName) ? fs.statSync(fileName).size : 0;
      } catch {
        this.currentSize = 0;
      }
    }
  }

  write(text) {
    this._ensureFile();
    try {
      this.currentFile.write(text + '\n');
      this.currentSize += Buffer.byteLength(text, 'utf8') + 1;
    } catch (e) {
      console.error('[Logger] Write error:', e.message);
    }
  }

  close() {
    if (this.currentFile) {
      try { this.currentFile.end(); } catch { /* 忽略 */ }
      this.currentFile = null;
    }
  }
}

/**
 * 日志记录器
 */
class Logger {
  constructor(options = {}) {
    const logLevelEnv = getEnvWithFallback('TRAECN_LOG_LEVEL', 'TRAE_LOG_LEVEL', 'info');
    const logFormatEnv = getEnvWithFallback('TRAECN_LOG_FORMAT', 'TRAE_LOG_FORMAT', 'json');

    this.level = LOG_LEVELS[logLevelEnv.toLowerCase()] ?? LOG_LEVELS.info;
    this.format = ['json', 'text'].includes(logFormatEnv.toLowerCase()) ? logFormatEnv.toLowerCase() : 'json';
    this.enableConsole = options.enableConsole !== false;
    this.enableFile = options.enableFile !== false;
    this.logDir = options.logDir || getEnvWithFallback('TRAECN_LOG_DIR', 'TRAE_LOG_DIR', path.join(process.cwd(), 'logs'));
    this.requestContext = new Map();
    this.writer = null;

    if (this.enableFile) {
      this.writer = new RotatingFileWriter({
        logDir: this.logDir,
        maxSize: options.maxSize || 10 * 1024 * 1024,
        maxFiles: options.maxFiles || 5
      });
    }
  }

  _createLogEntry(level, message, options = {}) {
    const entry = { timestamp: new Date().toISOString(), level, message: String(message) };
    if (options.requestId) entry.requestId = options.requestId;
    if (options.sessionId) entry.sessionId = options.sessionId;
    if (options.duration !== undefined) entry.duration = options.duration;
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      entry.metadata = sanitizeLog(options.metadata);
    }
    if (options.error instanceof Error) {
      entry.error = {
        name: options.error.name,
        message: options.error.message,
        stack: options.error.stack
      };
    }
    return entry;
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] >= this.level;
  }

  _write(entry) {
    const text = this.format === 'json' ? formatJson(entry) : formatText(entry);
    if (this.enableConsole) {
      const stream = entry.level === 'error' ? process.stderr : process.stdout;
      stream.write(text + '\n');
    }
    if (this.enableFile && this.writer) {
      this.writer.write(text);
    }
  }

  debug(message, options = {}) {
    if (!this._shouldLog('debug')) return;
    this._write(this._createLogEntry('debug', message, options));
  }

  info(message, options = {}) {
    if (!this._shouldLog('info')) return;
    this._write(this._createLogEntry('info', message, options));
  }

  warn(message, options = {}) {
    if (!this._shouldLog('warn')) return;
    this._write(this._createLogEntry('warn', message, options));
  }

  error(message, options = {}) {
    if (!this._shouldLog('error')) return;
    this._write(this._createLogEntry('error', message, options));
  }

  setRequestContext(requestId, context = {}) {
    this.requestContext.set(requestId, { ...context, timestamp: Date.now() });
  }

  getRequestContext(requestId) {
    return this.requestContext.get(requestId);
  }

  clearRequestContext(requestId) {
    this.requestContext.delete(requestId);
    const now = Date.now();
    for (const [id, ctx] of this.requestContext) {
      if (now - ctx.timestamp > 300000) {
        this.requestContext.delete(id);
      }
    }
  }

  createRequestLogger(requestId, sessionId) {
    return {
      debug: (message, metadata) => this.debug(message, { requestId, sessionId, metadata }),
      info: (message, metadata) => this.info(message, { requestId, sessionId, metadata }),
      warn: (message, metadata) => this.warn(message, { requestId, sessionId, metadata }),
      error: (message, options = {}) => this.error(message, { requestId, sessionId, ...options })
    };
  }

  close() {
    if (this.writer) {
      this.writer.close();
      this.writer = null;
    }
  }

  static levels = LOG_LEVELS;
}

const globalLogger = new Logger();

module.exports = {
  Logger,
  globalLogger,
  sanitizeLog,
  formatJson,
  formatText,
  LOG_LEVELS
};
