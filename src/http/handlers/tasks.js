'use strict';

/**
 * Tasks handlers — task history, single-task lookup, task replay, batch
 * submit/status/cancel, and the heavyweight delegate-async dispatcher.
 *
 * Each handler is `function handleX(req, res, ctx, ...pathParams)` — they
 * take the gateway instance as `ctx`. Behavior is preserved 1:1 with the
 * inline Gateway methods, just relocated.
 *
 * The Gateway retains thin delegating shims (e.g. `_handleTasksHistory`,
 * `_handleDelegateAsync`) so existing gateway.test.js cases that call
 * `gateway._handleTasksHistory(...)` continue to work unchanged.
 *
 * This file ships the simple sync handlers (history, get-task, replay)
 * first; the heavier async handlers (delegate-async, batch, status,
 * review, cancel, adopt-current) are added in follow-up commits.
 */

const { URL } = require('url');
const { parsePositiveInt, withoutTaskTrace } = require('../../shared/utils');

const ROUTES = [
  { method: 'GET', path: '/api/tasks/history', handler: '_handleTasksHistory', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'DELETE', path: '/api/tasks/history', handler: '_handleTasksHistoryClear', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/tasks/:taskId/replay', handler: '_handleTaskReplay', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'GET', path: '/api/tasks/:taskId', handler: '_handleGetTask', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
];

function handleTasksHistory(req, res, ctx) {
  const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
  const page = parsePositiveInt(parsedUrl.searchParams.get('page'), 1);
  const limit = Math.min(parsePositiveInt(parsedUrl.searchParams.get('limit'), 20), 100);
  const status = parsedUrl.searchParams.get('status') || null;
  const keyword = parsedUrl.searchParams.get('keyword') || null;
  const startDate = parsedUrl.searchParams.get('startDate') || null;
  const endDate = parsedUrl.searchParams.get('endDate') || null;
  const sessionId = parsedUrl.searchParams.get('sessionId') || null;

  const result = ctx.taskHistoryStore.getHistory({
    page, limit, status, keyword, startDate, endDate, sessionId
  });
  ctx._json(req, res, result);
}

function handleTasksHistoryClear(req, res, ctx) {
  const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
  let olderThanHours = null;
  if (parsedUrl.searchParams.has('olderThanHours')) {
    const value = parsedUrl.searchParams.get('olderThanHours').trim();
    olderThanHours = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(olderThanHours)
      || !Number.isSafeInteger(olderThanHours * 3600000)) {
      return ctx._json(req, res, { error: 'olderThanHours must be a non-negative safe integer' }, 400);
    }
  }
  const status = parsedUrl.searchParams.has('status')
    ? parsedUrl.searchParams.get('status').trim()
    : null;
  const beforeDate = parsedUrl.searchParams.has('beforeDate')
    ? parsedUrl.searchParams.get('beforeDate').trim()
    : null;
  if (status === '') {
    return ctx._json(req, res, { error: 'status must not be empty' }, 400);
  }
  if (beforeDate !== null && (!beforeDate || !Number.isFinite(Date.parse(beforeDate)))) {
    return ctx._json(req, res, { error: 'beforeDate must be a valid date' }, 400);
  }

  const result = ctx.taskHistoryStore.clearHistory({ olderThanHours, status, beforeDate });
  ctx._json(req, res, { success: true, ...result });
}

function handleGetTask(req, res, ctx, taskId) {
  const task = ctx.taskHistoryStore.getTask(taskId);
  if (!task) {
    return ctx._json(req, res, { error: 'Task not found' }, 404);
  }
  ctx._json(req, res, { ...task, result: withoutTaskTrace(task.result) });
}

function handleTaskReplay(req, res, ctx, taskId) {
  const replay = ctx.taskHistoryStore.getReplay(taskId);
  if (!replay) {
    return ctx._json(req, res, { error: 'Task not found' }, 404);
  }
  ctx._json(req, res, { ...replay, result: withoutTaskTrace(replay.result) });
}

module.exports = {
  ROUTES,
  handleTasksHistory,
  handleTasksHistoryClear,
  handleGetTask,
  handleTaskReplay,
};
