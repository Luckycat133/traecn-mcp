'use strict';

const { parseBody } = require('../request-gate');
const { isGenericQueueProbeTask } = require('../../shared/utils');

/**
 * solo-chat handlers.
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
      "path": "/api/new-chat",
      "handler": "_handleNewChat",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "GET",
      "path": "/api/solo/chats",
      "handler": "_handleListSoloChats",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "POST",
      "path": "/api/solo/chats/switch",
      "handler": "_handleSwitchSoloChat",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/solo/chats/submit",
      "handler": "_handleSubmitSoloChatTask",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    }
  ];

async function handleNewChat(req, res, ctx) {
  await ctx._ensureConnection();
  const success = await ctx.driver.newChat();
  ctx._json(req, res, { success });
}
async function handleListSoloChats(req, res, ctx) {
  await ctx._ensureConnection();
  const result = typeof ctx.driver.listSoloChats === 'function'
    ? await ctx.driver.listSoloChats()
    : { mode: 'unsupported', chats: [], count: 0, reason: 'driver_does_not_support_solo_chats' };
  ctx._json(req, res, result);
}
async function handleSwitchSoloChat(req, res, ctx) {
  const body = await parseBody(req);
  await ctx._ensureConnection();
  const result = typeof ctx.driver.switchSoloChat === 'function'
    ? await ctx.driver.switchSoloChat({
      index: Number.isInteger(body.index) ? body.index : null,
      textIncludes: body.textIncludes,
      titleIncludes: body.titleIncludes
    })
    : { success: false, reason: 'driver_does_not_support_solo_chats' };
  ctx._json(req, res, result, result.success === false ? 404 : 200);
}
async function handleSubmitSoloChatTask(req, res, ctx) {
  const body = await parseBody(req);
  if (isGenericQueueProbeTask(body && body.task)) {
    return ctx._json(req, res, {
      error: 'generic_queue_probe_task_rejected',
      message: 'Do not send queue probe prompts to Trae. Use /api/queue-status, /api/preflight, or wait_task for local waiting.'
    }, 400);
  }
  if (!body.task) {
    return ctx._json(req, res, { error: 'task is required' }, 400);
  }
  if (typeof body.task !== 'string' || body.task.length > 100000) {
    return ctx._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
  }

  return await ctx._withUiActionLock(async () => {
    await ctx._ensureConnection();
    if (typeof ctx.driver.switchMode === 'function') {
      await ctx.driver.switchMode('solo');
    }
    if (typeof ctx.driver.sendMessage !== 'function') {
      return ctx._json(req, res, { error: 'driver does not support message submission' }, 501);
    }

    const requestedSoloChat = ctx._normalizeSoloChatTarget(body.soloChat || body.soloChatTarget || {
      index: body.soloChatIndex,
      titleIncludes: body.soloChatTitleIncludes,
      textIncludes: body.soloChatTextIncludes
    });

    if (requestedSoloChat) {
      if (typeof ctx.driver.switchSoloChat !== 'function') {
        return ctx._json(req, res, { success: false, reason: 'driver_does_not_support_solo_chats' }, 501);
      }
      const switchResult = await ctx.driver.switchSoloChat(ctx._soloChatSwitchCriteria(requestedSoloChat));
      if (switchResult.success === false) {
        return ctx._json(req, res, switchResult, 404);
      }
    } else if (body.newChat !== false) {
      if (typeof ctx.driver.newChat !== 'function') {
        return ctx._json(req, res, { error: 'driver does not support new chat creation' }, 501);
      }
      await ctx.driver.newChat();
    }

    await ctx.driver.sendMessage(ctx._taskWithProjectContext(body.task, body.projectPath));
    const queueStatus = typeof ctx.driver.checkQueueStatus === 'function'
      ? await ctx.driver.checkQueueStatus()
      : { queued: true, running: false, canSubmit: false };
    const task = ctx._createQueuedTask({
      ...body,
      soloChat: requestedSoloChat,
      includeProcessText: body.includeProcessText === true
    }, {
      ...queueStatus,
      queued: queueStatus.queued !== false,
      queueMessage: queueStatus.queueMessage || queueStatus.message || 'submitted to Solo chat'
    });
    task.status = 'executing';
    task.submittedToTrae = true;
    task.submittedAt = Date.now();
    task.queueState = queueStatus.running ? 'running' : (queueStatus.queued ? 'queued' : 'submitted');
    task.queueMessage = queueStatus.queueMessage || queueStatus.message || 'submitted to Solo chat';
    await ctx._captureTaskSoloChat(task);
    ctx._syncTaskHistoryMirror(task);
    ctx._persistActiveQueue();
    ctx._ensureBackgroundPolling();

    return ctx._json(req, res, {
      taskId: task.taskId,
      status: task.status,
      submittedToTrae: true,
      soloChat: task.soloChat || null,
      queueDetails: ctx._queueDetailsFromStatus(queueStatus, task.currentModel),
      reviewRequired: task.reviewRequired,
      autoContinue: task.autoContinue === true,
      followupCount: task.followupTasks.length,
      message: '任务已提交到 Solo 对话，后台会切回该对话收集结果'
    }, 202);
  });
}

module.exports = { ROUTES, handleNewChat, handleListSoloChats, handleSwitchSoloChat, handleSubmitSoloChatTask };