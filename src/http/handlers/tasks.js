'use strict';

/**
 * Task-related handlers.
 *
 * Covers: history list / clear, get-task, replay, status, review, cancel,
 * delegate (sync + async), batch submit/status/cancel, and the
 * "adopt current" workflow. Each handler is `async function handleX(req,
 * res, ctx)` for route-table composability.
 */

const ROUTES = [
  { method: 'GET', path: '/api/tasks/history', handler: '_handleTasksHistory', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'DELETE', path: '/api/tasks/history', handler: '_handleTasksHistoryClear', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/tasks/:taskId/replay', handler: '_handleTaskReplay', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'GET', path: '/api/tasks/:taskId', handler: '_handleGetTask', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'GET', path: '/api/task/:taskId', handler: '_handleTaskStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'POST', path: '/api/task/:taskId/review', handler: '_handleTaskReview', requiresAuth: true, requiresRateLimit: true, requiresBody: true, pathParams: ['taskId'] },
  { method: 'POST', path: '/api/task/:taskId/cancel', handler: '_handleTaskCancel', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['taskId'] },
  { method: 'POST', path: '/api/tasks/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate-async', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/task/adopt-current', handler: '_handleAdoptCurrentTask', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/tasks/batch', handler: '_handleBatchSubmit', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/tasks/batch/:batchId', handler: '_handleBatchStatus', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['batchId'] },
  { method: 'DELETE', path: '/api/tasks/batch/:batchId', handler: '_handleBatchCancel', requiresAuth: true, requiresRateLimit: true, requiresBody: false, pathParams: ['batchId'] },
];

function handleTasksHistory() { throw new Error('wired via route-table'); }
function handleTasksHistoryClear() { throw new Error('wired via route-table'); }
function handleGetTask() { throw new Error('wired via route-table'); }
function handleTaskReplay() { throw new Error('wired via route-table'); }
function handleTaskStatus() { throw new Error('wired via route-table'); }
function handleTaskReview() { throw new Error('wired via route-table'); }
function handleTaskCancel() { throw new Error('wired via route-table'); }
function handleDelegateAsync() { throw new Error('wired via route-table'); }
function handleAdoptCurrentTask() { throw new Error('wired via route-table'); }
function handleBatchSubmit() { throw new Error('wired via route-table'); }
function handleBatchStatus() { throw new Error('wired via route-table'); }
function handleBatchCancel() { throw new Error('wired via route-table'); }

module.exports = {
  ROUTES,
  handleTasksHistory,
  handleTasksHistoryClear,
  handleGetTask,
  handleTaskReplay,
  handleTaskStatus,
  handleTaskReview,
  handleTaskCancel,
  handleDelegateAsync,
  handleAdoptCurrentTask,
  handleBatchSubmit,
  handleBatchStatus,
  handleBatchCancel,
};