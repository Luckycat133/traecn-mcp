'use strict';

const { parseBody } = require('../request-gate');
const { sanitizeLog } = require('../../shared/utils');

/**
 * config handlers.
 *
 * Moved verbatim from src/http/gateway.js. Each handler is now an
 * exported function with signature `function handleX(req, res, ctx, ...pathParams)`
 * taking the gateway instance as `ctx`. Behavior is preserved 1:1.
 *
 * The Gateway retains thin delegating shims (e.g. `_handleCreateSession`) so
 * existing gateway.test.js cases that call `gateway._handleCreateSession(...)`
 * continue to work unchanged.
 */

const ROUTES = [
    {
      "method": "GET",
      "path": "/api/config",
      "handler": "_handleGetConfig",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/config/schema",
      "handler": "_handleGetConfigSchema",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "POST",
      "path": "/api/config/update",
      "handler": "_handleUpdateConfig",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/config/reset",
      "handler": "_handleResetConfig",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/config/diff",
      "handler": "_handleConfigDiff",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    }
  ];

function handleGetConfig(req, res, ctx) {
  const config = ctx.configManager.getConfig();
  const auditLog = ctx.configManager.getAuditLog();
  ctx._json(req, res, {
    config: sanitizeLog(config),
    auditLog: sanitizeLog(auditLog.slice(-10))
  });
}
function handleGetConfigSchema(req, res, ctx) {
  const schema = ctx.configManager.getSchema();
  ctx._json(req, res, {
    schema,
    defaults: {
      logLevel: schema.logLevel.default,
      rateLimit: {
        windowMs: schema.rateLimit.windowMs.default,
        maxRequests: schema.rateLimit.maxRequests.default
      },
      timeout: {
        request: schema.timeout.request.default,
        response: schema.timeout.response.default
      },
      cors: {
        allowedOrigins: schema.cors.allowedOrigins.default,
        enabled: schema.cors.enabled.default
      },
      plugins: schema.plugins.default
    }
  });
}
async function handleUpdateConfig(req, res, ctx) {
  const body = await parseBody(req);
  try {
    const result = ctx.configManager.update(body);
    ctx._json(req, res, sanitizeLog(result));
  } catch (err) {
    if (err.name === 'ConfigValidationError') {
      ctx._json(req, res, {
        success: false,
        error: err.message,
        validationErrors: err.errors
      }, 400);
    } else {
      throw err;
    }
  }
}
async function handleResetConfig(req, res, ctx) {
  const result = ctx.configManager.reset();
  ctx._json(req, res, sanitizeLog(result));
}
function handleConfigDiff(req, res, ctx) {
  const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
  const previousTimestamp = parsedUrl.searchParams.get('previous');

  let previousConfig;
  if (previousTimestamp) {
    const history = ctx.configManager.getHistory();
    const record = history.find(h => h.timestamp === previousTimestamp);
    previousConfig = record ? record.newConfig : null;
  } else {
    previousConfig = ctx.configManager.getSchema();
    previousConfig = {
      logLevel: previousConfig.logLevel.default,
      rateLimit: {
        windowMs: previousConfig.rateLimit.windowMs.default,
        maxRequests: previousConfig.rateLimit.maxRequests.default
      },
      timeout: {
        request: previousConfig.timeout.request.default,
        response: previousConfig.timeout.response.default
      },
      cors: {
        allowedOrigins: previousConfig.cors.allowedOrigins.default,
        enabled: previousConfig.cors.enabled.default
      },
      plugins: previousConfig.plugins.default
    };
  }

  const diff = ctx.configManager.getDiff(previousConfig);
  const history = ctx.configManager.getHistory();
  ctx._json(req, res, {
    diff: sanitizeLog(diff),
    history: sanitizeLog(history.slice(-20))
  });
}

module.exports = { ROUTES, handleGetConfig, handleGetConfigSchema, handleUpdateConfig, handleResetConfig, handleConfigDiff };
