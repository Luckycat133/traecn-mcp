'use strict';

const { parseBody } = require('../request-gate');
const { hasDriverCapability } = require('./helpers');

/**
 * task-actions handlers.
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
      "path": "/api/task/:taskId",
      "handler": "_handleTaskStatus",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false,
      "pathParams": [
        "taskId"
      ]
    },
    {
      "method": "POST",
      "path": "/api/task/:taskId/review",
      "handler": "_handleTaskReview",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true,
      "pathParams": [
        "taskId"
      ]
    },
    {
      "method": "POST",
      "path": "/api/task/:taskId/cancel",
      "handler": "_handleTaskCancel",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false,
      "pathParams": [
        "taskId"
      ]
    },
    {
      "method": "POST",
      "path": "/api/task/adopt-current",
      "handler": "_handleAdoptCurrentTask",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    }
  ];

async function handleTaskStatus(req, res, ctx, taskId) {
  const task = ctx.taskQueue.get(taskId);
  if (!task) {
    const historyTask = ctx.taskHistoryStore.getTask(taskId);
    if (historyTask) {
      return ctx._json(req, res, ctx._historyTaskStatusResponse(historyTask));
    }
    return ctx._json(req, res, { error: 'Task not found' }, 404);
  }

  if (task.status === 'queued') {
    await ctx._refreshQueuedTaskSnapshot(task);
  } else if (task.status === 'executing') {
    await ctx._refreshExecutingTaskSnapshot(task);
  }

  const response = {
    taskId,
    status: task.status,
    createdAt: task.createdAt,
    elapsed: Date.now() - task.createdAt
  };

  switch (task.status) {
    case 'queued':
      response.message = '队列等待中';
      response.queueElapsed = Date.now() - task.createdAt;
      response.deadline = task.deadline || null;
      response.remaining = task.deadline ? Math.max(0, task.deadline - Date.now()) : null;
      response.queueDetails = {
        state: task.queueState || 'queued',
        queuePosition: task.queuePosition || null,
        queueEstimatedWait: task.queueEstimatedWait || null,
        queueMessage: task.queueMessage || null,
        currentModel: task.currentModel || null,
        canSubmit: task.queueCanSubmit === true
      };
      response.fallbackModels = task.fallbackModels || [];
      response.modelProbe = {
        lastModelProbeAt: task.lastModelProbeAt || null,
        nextModelProbeAt: task.nextModelProbeAt || null,
        results: task.modelProbeResults || []
      };
      break;
    case 'executing':
      response.message = 'Trae 正在执行';
      response.submittedToTrae = task.submittedToTrae === true;
      response.submittedAt = task.submittedAt || null;
      response.queueDetails = {
        state: task.queueState || null,
        queuePosition: task.queuePosition || null,
        queueEstimatedWait: task.queueEstimatedWait || null,
        queueMessage: task.queueMessage || null,
        currentModel: task.currentModel || null,
        canSubmit: task.queueCanSubmit === true
      };
      break;
    case 'approval_required':
      response.message = 'Trae 需要先处理确认弹窗';
      response.result = {
        text: task.result?.text || '',
        needsApproval: true,
        question: task.result?.question || '',
        dialogType: task.result?.dialogType || null,
        buttons: task.result?.buttons || [],
        options: task.result?.options || [],
        answerAction: task.result?.dialogType === 'review_scope_question'
          ? { endpoint: '/api/dialog/approve', method: 'POST', body: { action: 'answer', answer: '<option label>' } }
          : null
      };
      break;
    case 'awaiting_review':
      response.message = '等待人工审查';
      response.reviewRequired = true;
      response.followupCount = task.followupTasks?.length || 0;
      response.result = {
        text: task.result?.text || '',
        stable: task.result?.stable || false,
        elapsedMs: task.result?.elapsedMs || null,
        timedOut: task.result?.timedOut || false,
        needsApproval: false
      };
      break;
    case 'done':
      response.message = '执行完成';
      response.result = {
        text: task.result.text,
        stable: task.result.stable,
        elapsedMs: task.result.elapsedMs,
        timedOut: task.result.timedOut || false,
        needsApproval: task.result.needsApproval || false
      };
      break;
    case 'error':
      response.message = '执行出错';
      response.error = task.error;
      break;
    case 'cancelled':
      response.message = '已取消';
      break;
    case 'queue_timeout':
      response.message = '排队超时，请稍后重试或切换模型';
      response.error = 'Task exceeded queue wait timeout';
      break;
    case 'review_rejected':
      response.message = '审查未通过，任务已停止';
      response.reviewDecision = task.reviewDecision || 'reject';
      response.reviewNotes = task.reviewNotes || '';
      break;
  }

  ctx._json(req, res, response);
}
async function handleTaskReview(req, res, ctx, taskId) {
  const task = ctx.taskQueue.get(taskId);
  if (!task) {
    return ctx._json(req, res, { error: 'Task not found' }, 404);
  }
  if (task.status !== 'awaiting_review') {
    return ctx._json(req, res, {
      error: 'Task is not awaiting review',
      status: task.status
    }, 400);
  }

  const body = await parseBody(req);
  const decision = String(body.decision || '').toLowerCase();
  const notes = typeof body.notes === 'string' ? body.notes : '';
  if (!['approve', 'continue', 'reject'].includes(decision)) {
    return ctx._json(req, res, { error: 'decision must be approve, continue, or reject' }, 400);
  }

  const result = await ctx._continueReviewedTask(taskId, task, decision === 'continue' ? 'approve' : decision, notes);
  ctx._json(req, res, result);
}
async function handleTaskCancel(req, res, ctx, taskId) {
  const task = ctx.taskQueue.get(taskId);
  if (!task) {
    return ctx._json(req, res, { error: 'Task not found' }, 404);
  }
  if (!['queued', 'executing', 'awaiting_review', 'approval_required'].includes(task.status)) {
    return ctx._json(req, res, {
      error: 'Task is not in a cancellable state',
      status: task.status
    }, 400);
  }
  let stopResult = null;
  if (task.status === 'executing' && task.submittedToTrae === true && ctx.driver && typeof ctx.driver.stopGeneration === 'function') {
    try {
      stopResult = await ctx.driver.stopGeneration();
    } catch (err) {
      stopResult = { success: false, error: err.message };
    }
  }
  // Remove task from locks if it's there
  ctx.taskLocks.delete(taskId);
  task.status = 'cancelled';
  task.error = null;
  task.cancelledAt = Date.now();
  if (stopResult) task.stopResult = stopResult;
  ctx.taskHistoryStore.cancelTask(taskId);
  if (ctx.wsHandler) {
    ctx.wsHandler.notifyTaskStatusChange(taskId, task);
  }
  ctx._syncTaskHistoryMirror(task);
  ctx._persistActiveQueue();
  ctx._json(req, res, { taskId, status: 'cancelled', stopResult });
}
async function handleAdoptCurrentTask(req, res, ctx) {
  const body = await parseBody(req);
  const taskText = typeof body.task === 'string' && body.task.trim()
    ? body.task
    : 'Adopt existing Trae request from current chat';
  if (taskText.length > 100000) {
    return ctx._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
  }

  await ctx._ensureConnection();
  const queueStatus = await ctx.driver.checkQueueStatus();
  const hasSubmittedWork = queueStatus.queued === true || queueStatus.running === true || body.force === true;
  if (!hasSubmittedWork) {
    return ctx._json(req, res, {
      error: 'No visible queued or running Trae request to adopt. Pass force=true only if the current chat is already producing a response.',
      queueDetails: ctx._queueDetailsFromStatus(queueStatus)
    }, 409);
  }

  let activeSnapshot = null;
  if (ctx.driver && hasDriverCapability(ctx, 'getActiveSoloChat')) {
    try {
      activeSnapshot = await ctx.driver.getActiveSoloChat();
    } catch (err) {
      ctx.taskHistoryStore?.recordStep?.('adopt-current', 'active_solo_chat_probe_failed', {
        success: false,
        error: err.message
      });
    }
  }
  const existing = ctx._findSubmittedTaskForActiveSoloChat?.(activeSnapshot?.active || null);
  if (existing) {
    const existingTask = existing.task;
    existingTask.queueMessage = queueStatus.queueMessage || queueStatus.message || existingTask.queueMessage || 'adopted existing Trae request';
    existingTask.currentModel = queueStatus.currentModel || existingTask.currentModel || null;
    existingTask.queuePosition = queueStatus.queuePosition || queueStatus.position || existingTask.queuePosition || null;
    existingTask.queueEstimatedWait = queueStatus.queueEstimatedWait || existingTask.queueEstimatedWait || null;
    existingTask.queueCanSubmit = queueStatus.canSubmit === true;
    existingTask.queueState = queueStatus.running ? 'running' : (queueStatus.queued ? 'queued' : (existingTask.queueState || 'running'));
    ctx._syncTaskHistoryMirror(existingTask);
    ctx._persistActiveQueue();
    ctx._ensureBackgroundPolling();
    return ctx._json(req, res, {
      taskId: existing.taskId,
      status: existingTask.status,
      submittedToTrae: true,
      deduped: true,
      reviewRequired: existingTask.reviewRequired,
      followupCount: existingTask.followupTasks?.length || 0,
      queueDetails: {
        state: existingTask.queueState || (queueStatus.running ? 'running' : 'queued'),
        currentModel: existingTask.currentModel || queueStatus.currentModel || null,
        queuePosition: existingTask.queuePosition || null,
        queueEstimatedWait: existingTask.queueEstimatedWait || null,
        queueMessage: existingTask.queueMessage || null,
        canSubmit: existingTask.queueCanSubmit === true
      },
      message: '当前 Trae 请求已被本地任务接管；返回已有 taskId，不重复创建任务'
    }, 200);
  }

  const task = ctx._createQueuedTask({
    task: taskText,
    projectPath: body.projectPath || null,
    reviewRequired: body.reviewRequired === true,
    autoContinue: body.autoContinue === true,
    followupTasks: ctx._normalizeFollowupTasks(body.followupTasks),
    autoApproveDialog: body.autoApproveDialog,
    chatId: body.chatId || null,
    includeProcessText: body.includeProcessText === true,
    notifyUrl: body.notifyUrl,
    fallbackModels: body.fallbackModels,
    autoModelFallback: body.autoModelFallback === true,
    modelProbeIntervalMs: body.modelProbeIntervalMs
  }, {
    ...queueStatus,
    queued: queueStatus.queued !== false,
    queueMessage: queueStatus.queueMessage || queueStatus.message || 'adopted existing Trae request'
  });
  task.status = 'executing';
  task.submittedToTrae = true;
  task.submittedAt = Number.isFinite(Number(body.submittedAt)) ? Number(body.submittedAt) : Date.now();
  task.queueMessage = queueStatus.queueMessage || queueStatus.message || 'adopted existing Trae request';
  await ctx._captureTaskSoloChat(task);
  ctx._syncTaskHistoryMirror(task);
  ctx._persistActiveQueue();
  ctx._ensureBackgroundPolling();

  return ctx._json(req, res, {
    taskId: task.taskId,
    status: task.status,
    submittedToTrae: true,
    reviewRequired: task.reviewRequired,
    followupCount: task.followupTasks.length,
    queueDetails: {
      state: task.queueState || (queueStatus.running ? 'running' : 'queued'),
      currentModel: task.currentModel || queueStatus.currentModel || null,
      queuePosition: task.queuePosition || null,
      queueEstimatedWait: task.queueEstimatedWait || null,
      queueMessage: task.queueMessage || null,
      canSubmit: task.queueCanSubmit === true
    },
    message: '已接管当前 Trae 请求；后台将只等待/收集现有结果，不会重新发送任务'
  }, 202);
}

module.exports = { ROUTES, handleTaskStatus, handleTaskReview, handleTaskCancel, handleAdoptCurrentTask };
