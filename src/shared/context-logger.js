'use strict';

const { globalLogger } = require('./logger');
const requestContext = require('./request-context');

/**
 * Returns a logger-like object that automatically merges the active request
 * context (requestId/sessionId/authKeyId) into every log entry. Use this
 * inside the request scope to avoid threading the requestId through every
 * call site.
 *
 * Example:
 *   const log = require('./context-logger');
 *   log.info('task delegated', { taskId: 't-1' });
 *   // => { timestamp, level: 'info', message: 'task delegated',
 *   //      requestId: 'req-...', metadata: { taskId: 't-1' } }
 *
 * Falls back to the bare global logger when no request context is active
 * (e.g. background workers, lifecycle hooks).
 */
function withContext() {
  return {
    debug(message, metadata) {
      globalLogger.debug(message, mergeCtx({ metadata }));
    },
    info(message, metadata) {
      globalLogger.info(message, mergeCtx({ metadata }));
    },
    warn(message, metadata) {
      globalLogger.warn(message, mergeCtx({ metadata }));
    },
    error(message, options = {}) {
      // error() accepts { metadata, error } in logger.js
      globalLogger.error(message, mergeCtx(options));
    },
  };
}

function mergeCtx(options) {
  const ctx = requestContext.getContext();
  if (!ctx) return options;
  return {
    ...options,
    requestId: options.requestId || ctx.requestId,
    sessionId: options.sessionId || ctx.sessionId,
    // Surface key actor info as metadata keys (kept conservative — log readers
    // already know how to flatten these without PII risk).
    metadata: {
      ...(ctx.authKeyId ? { authKeyId: ctx.authKeyId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(options.metadata || {}),
    },
  };
}

module.exports = { withContext };