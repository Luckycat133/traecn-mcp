'use strict';

const fs = require('fs');
const path = require('path');
const { getEnvWithFallback } = require('./utils');

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const SENSITIVE_KEYS = ['token', 'password', 'secret', 'credential', 'authorization'];

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

function formatJson(logEntry) {
  return JSON.stringify(logEntry);
}

class RotatingFileWriter {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.maxSize = options.maxSize || 10 * 1024 * 1024;
    this.maxFiles = options.maxFiles || 5;
    this.currentFile = null;
    this.currentSize = 0;
    this.datePattern = options.datePattern || 'yyyy-MM-dd';
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
    const yyyy = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${MM}-${dd}`;
  }

  _getFileName(dateStr) {
    return path.join(this.logDir, `app-${dateStr}.log`);
  }

  _rotateByDate() {
    const dateStr = this._getDateStr();
    if (dateStr === this.currentDate && this.currentFile) return;

    if (this.currentFile) {
      try {
        this.currentFile.end();
      } catch (e) {}
    }

    this.currentDate = dateStr;
    this.currentFile = null;
    this.currentSize = 0;
  }

  _rotateBySize() {
    if (this.currentSize < this.maxSize) return;

    const dateStr = this._getDateStr();
    const baseName = this._getFileName(dateStr).replace('.log', '');

    for (let i = this.maxFiles - 1; i > 0; i--) {
      const oldFile = `${baseName}.${i}.log`;
      const newFile = `${baseName}.${i + 1}.log`;
      try {
        if (fs.existsSync(newFile)) {
          fs.unlinkSync(newFile);
        }
        if (fs.existsSync(oldFile)) {
          fs.renameSync(oldFile, newFile);
        }
      } catch (e) {}
    }

    const currentLog = `${baseName}.log`;
    const firstRotated = `${baseName}.1.log`;
    try {
      if (fs.existsSync(currentLog)) {
        if (fs.existsSync(firstRotated)) {
          fs.unlinkSync(firstRotated);
        }
        fs.renameSync(currentLog, firstRotated);
      }
    } catch (e) {}

    this.currentFile = null;
    this.currentSize = 0;
  }

  _ensureFile() {
    this._rotateByDate();
    this._rotateBySize();

    if (!this.currentFile) {
      const fileName = this._getFileName(this.currentDate);
      this.currentFile = fs.createWriteStream(fileName, { flags: 'a' });
      try {
        this.currentSize = fs.existsSync(fileName) ? fs.statSync(fileName).size : 0;
      } catch (e) {
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
      try {
        this.currentFile.end();
        this.currentFile = null;
      } catch (e) {}
    }
  }

  cleanupOldFiles() {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('app-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          time: fs.statSync(path.join(this.logDir, f)).mtime
        }))
        .sort((a, b) => b.time - a.time);

      for (let i = this.maxFiles; i < files.length; i++) {
        try {
          fs.unlinkSync(files[i].path);
        } catch (e) {}
      }
    } catch (e) {}
  }
}

class Logger {
  constructor(options = {}) {
    const logLevelEnv = getEnvWithFallback('TRAECN_LOG_LEVEL', 'TRAE_LOG_LEVEL', 'info');
    const logFormatEnv = getEnvWithFallback('TRAECN_LOG_FORMAT', 'TRAE_LOG_FORMAT', 'json');

    this.level = LOG_LEVELS[logLevelEnv.toLowerCase()] !== undefined
      ? LOG_LEVELS[logLevelEnv.toLowerCase()]
      : LOG_LEVELS.info;

    this.format = ['json', 'text'].includes(logFormatEnv.toLowerCase())
      ? logFormatEnv.toLowerCase()
      : 'json';

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

    this._cleanupTimer = null;
    if (this.writer) {
      this._cleanupTimer = setInterval(() => {
        if (this.writer) {
          this.writer.cleanupOldFiles();
        }
      }, 3600000);
      if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }
  }

  _createLogEntry(level, message, options = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: String(message)
    };

    if (options.requestId) entry.requestId = options.requestId;
    if (options.sessionId) entry.sessionId = options.sessionId;
    if (options.duration !== undefined) entry.duration = options.duration;
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      entry.metadata = sanitizeLog(options.metadata);
    }

    if (options.error && options.error instanceof Error) {
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
    const text = this.format === 'json'
      ? formatJson(entry)
      : formatText(entry);

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
    this.requestContext.set(requestId, {
      ...context,
      timestamp: Date.now()
    });
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
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
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
