'use strict';

/**
 * queue handlers.
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
      "path": "/api/queue-status",
      "handler": "_handleQueueStatus",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/queue/status",
      "handler": "_handleQueueStatusList",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    }
  ];

async function handleQueueStatus(req, res, ctx) {
  await ctx._ensureConnection();
  const status = ctx._applyRecentQueueSnapshot(await ctx.driver.checkQueueStatus());
  ctx._json(req, res, status);
}
function handleQueueStatusList(req, res, ctx) {
  const tasks = Array.from(ctx.taskQueue.entries())
    .filter(([, t]) => !ctx._isTerminalTaskStatus(t.status))
    .map(([id, t]) => ({
    taskId: id,
    status: t.status,
    createdAt: t.createdAt,
    currentModel: t.currentModel || null,
    fallbackModels: t.fallbackModels || [],
    lastModelProbeAt: t.lastModelProbeAt || null,
    nextModelProbeAt: t.nextModelProbeAt || null,
    modelProbeResults: t.modelProbeResults || [],
    submittedToTrae: t.submittedToTrae === true,
    submittedAt: t.submittedAt || null,
    result: t.status === 'done' ? t.result : undefined,
    error: t.status === 'error' ? t.error : undefined
    }));
  ctx._json(req, res, { tasks });
}

module.exports = { ROUTES, handleQueueStatus, handleQueueStatusList };