'use strict';

const { parseBody } = require('../request-gate');
const { isGenericQueueProbeTask } = require('../../shared/utils');

/**
 * batch handlers.
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
      "method": "POST",
      "path": "/api/tasks/batch",
      "handler": "_handleBatchSubmit",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "GET",
      "path": "/api/tasks/batch/:batchId",
      "handler": "_handleBatchStatus",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false,
      "pathParams": [
        "batchId"
      ]
    },
    {
      "method": "DELETE",
      "path": "/api/tasks/batch/:batchId",
      "handler": "_handleBatchCancel",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false,
      "pathParams": [
        "batchId"
      ]
    }
  ];

async function handleBatchSubmit(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
    return ctx._json(req, res, { error: 'tasks array is required and must not be empty' }, 400);
  }
  if (body.tasks.length > 100) {
    return ctx._json(req, res, { error: 'Maximum 100 tasks per batch' }, 400);
  }
  for (let idx = 0; idx < body.tasks.length; idx++) {
    const item = body.tasks[idx];
    if (!item.task || typeof item.task !== 'string') {
      return ctx._json(req, res, { error: 'Each task must have a task string' }, 400);
    }
    if (item.task.length > 100000) {
      return ctx._json(req, res, { error: 'Each task must be at most 100000 characters' }, 400);
    }
    if (isGenericQueueProbeTask(item.task)) {
      return ctx._json(req, res, {
        error: 'generic_queue_probe_task_rejected',
        message: 'Batch contains a queue probe prompt. Use /api/queue-status, /api/preflight, or wait_task for local waiting.',
        offendingIndex: idx
      }, 400);
    }
  }

  const strategy = body.strategy || 'parallel';
  if (!['parallel', 'sequential', 'priority'].includes(strategy)) {
    return ctx._json(req, res, { error: 'strategy must be "parallel", "sequential", or "priority"' }, 400);
  }

  const maxConcurrency = Math.min(Math.max(body.maxConcurrency || 5, 1), 20);
  const onComplete = body.onComplete || null;

  const batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const tasks = body.tasks.map((item, index) => ({
    taskId: `${batchId}_${index}`,
    task: item.task,
    priority: item.priority || 5,
    status: 'pending',
    result: null,
    error: null
  }));

  if (strategy === 'priority') {
    tasks.sort((a, b) => b.priority - a.priority);
  }

  const batch = {
    batchId,
    tasks,
    strategy,
    maxConcurrency,
    onComplete,
    status: 'running',
    createdAt: Date.now(),
    completedCount: 0,
    failedCount: 0,
    totalCount: tasks.length,
    results: []
  };

  ctx.batchTasks.set(batchId, batch);
  ctx._startBatchExecution(batchId);

  return ctx._json(req, res, {
    batchId,
    status: 'running',
    totalTasks: tasks.length,
    strategy,
    maxConcurrency,
    message: `Batch submitted with ${tasks.length} tasks using ${strategy} strategy`
  }, 202);
}
function handleBatchStatus(req, res, ctx, batchId) {
  const batch = ctx.batchTasks.get(batchId);
  if (!batch) {
    return ctx._json(req, res, { error: 'Batch not found' }, 404);
  }

  const response = {
    batchId: batch.batchId,
    status: batch.status,
    strategy: batch.strategy,
    maxConcurrency: batch.maxConcurrency,
    totalCount: batch.totalCount,
    completedCount: batch.completedCount,
    failedCount: batch.failedCount,
    pendingCount: batch.tasks.filter(t => t.status === 'pending').length,
    executingCount: batch.tasks.filter(t => t.status === 'executing').length,
    createdAt: batch.createdAt,
    tasks: batch.tasks.map(t => ({
      taskId: t.taskId,
      priority: t.priority,
      status: t.status,
      result: t.result,
      error: t.error
    }))
  };

  ctx._json(req, res, response);
}
function handleBatchCancel(req, res, ctx, batchId) {
  const batch = ctx.batchTasks.get(batchId);
  if (!batch) {
    return ctx._json(req, res, { error: 'Batch not found' }, 404);
  }

  if (batch.status === 'completed' || batch.status === 'cancelled') {
    return ctx._json(req, res, {
      error: 'Batch is already ' + batch.status,
      status: batch.status
    }, 400);
  }

  batch.status = 'cancelled';
  batch._cancelled = true;
  for (const task of batch.tasks) {
    if (task.status === 'pending' || task.status === 'executing') {
      task.status = 'cancelled';
    }
  }

  ctx.batchTasks.delete(batchId);

  ctx._json(req, res, {
    batchId,
    status: 'cancelled',
    message: 'Batch cancelled'
  });
}

module.exports = { ROUTES, handleBatchSubmit, handleBatchStatus, handleBatchCancel };