'use strict';

const { sanitizeLog } = require('../shared/logger');

function getLogLevel() {
  return process.env.TRAECN_LOGGING_LEVEL || process.env.TRAE_LOGGING_LEVEL || 'info';
}

function shouldLog(level) {
  const levels = ['debug', 'info', 'warn', 'error'];
  const currentLevel = getLogLevel();
  return levels.indexOf(level) >= levels.indexOf(currentLevel);
}

function formatTimestamp() {
  return new Date().toISOString();
}

function formatRequest(req) {
  return {
    method: req.method,
    url: req.url,
    path: req._normalizedUrl || req.url,
    headers: sanitizeLog(req.headers || {}),
    ip: req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers?.['user-agent'] || 'unknown'
  };
}

function formatTaskContext(ctx) {
  const sanitized = {
    task: ctx.task,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    timestamp: ctx.timestamp || new Date().toISOString()
  };

  if (ctx.body) {
    sanitized.body = sanitizeLog(ctx.body);
  }

  return sanitized;
}

function createLoggingPlugin(options = {}) {
  const includeRequestBody = options.includeRequestBody !== false;
  const includeResponseBody = options.includeResponseBody !== false;
  const logHeaders = options.logHeaders !== false;

  return {
    name: 'logging-plugin',
    version: '1.0.0',

    hooks: {
      onStartup: async (gateway) => {
        if (shouldLog('info')) {
          console.log(`[logging-plugin] Logging plugin started on gateway at ${gateway.host}:${gateway.port}`);
          console.log(`[logging-plugin] Log level: ${getLogLevel()}`);
        }
      },

      onShutdown: async (gateway) => {
        if (shouldLog('info')) {
          console.log('[logging-plugin] Logging plugin shutting down');
        }
      },

      beforeTask: async (ctx) => {
        if (!shouldLog('debug')) return ctx;

        const req = ctx.req;
        if (!req) return ctx;

        console.log(`[logging-plugin] [${formatTimestamp()}] --> ${req.method} ${req.url}`);
        if (logHeaders) {
          console.log(`[logging-plugin] [${formatTimestamp()}]     Headers:`, JSON.stringify(sanitizeLog(req.headers || {})));
        }
        if (includeRequestBody && ctx.body) {
          console.log(`[logging-plugin] [${formatTimestamp()}]     Body:`, JSON.stringify(sanitizeLog(ctx.body)));
        }

        return ctx;
      },

      afterTask: async (ctx, result) => {
        if (!shouldLog('debug')) return result;

        const req = ctx.req;
        if (!req) return result;

        const elapsed = result?.elapsedMs ? ` (${result.elapsedMs}ms)` : '';
        console.log(`[logging-plugin] [${formatTimestamp()}] <-- ${req.method} ${req.url}${elapsed}`);
        if (includeResponseBody && result) {
          console.log(`[logging-plugin] [${formatTimestamp()}]     Response:`, JSON.stringify(sanitizeLog(result)));
        }

        return result;
      },

      onError: async (ctx, error) => {
        if (shouldLog('error')) {
          const req = ctx?.req;
          const path = req ? `${req.method} ${req.url}` : 'unknown';
          console.error(`[logging-plugin] [${formatTimestamp()}] ERROR on ${path}: ${error.message}`);
          if (ctx?.body) {
            console.error(`[logging-plugin] [${formatTimestamp()}]     Request body:`, JSON.stringify(sanitizeLog(ctx.body)));
          }
          console.error(`[logging-plugin] [${formatTimestamp()}]     Stack:`, error.stack);
        }
      }
    },

    middleware: async (ctx, next) => {
      const startTime = Date.now();

      if (shouldLog('info')) {
        const req = ctx.req;
        if (req) {
          console.log(`[logging-plugin] [${formatTimestamp()}] ${req.method} ${req.url} - Request received`);
        }
      }

      try {
        const result = await next();
        const elapsed = Date.now() - startTime;

        if (shouldLog('info')) {
          const req = ctx.req;
          if (req) {
            console.log(`[logging-plugin] [${formatTimestamp()}] ${req.method} ${req.url} - Completed in ${elapsed}ms`);
          }
        }

        return result;
      } catch (err) {
        const elapsed = Date.now() - startTime;

        if (shouldLog('error')) {
          const req = ctx.req;
          if (req) {
            console.error(`[logging-plugin] [${formatTimestamp()}] ${req.method} ${req.url} - Failed in ${elapsed}ms: ${err.message}`);
          }
        }

        throw err;
      }
    }
  };
}

module.exports = createLoggingPlugin;
module.exports.default = createLoggingPlugin;
