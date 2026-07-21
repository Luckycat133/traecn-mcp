'use strict';

/**
 * Delegate-async handler — the heavyweight submit endpoint for
 * background-eligible tasks.
 *
 * Moved verbatim from gateway.js. The original implementation was a
 * class method that called into ~25 Gateway fields and helpers via
 * `this.<x>`. Here it is exposed as a function `handleDelegateAsync(req,
 * res, ctx)` that takes the gateway instance as `ctx`.
 *
 * Behavior is preserved 1:1 — no logic changes, just relocation. The
 * Gateway retains a thin delegating shim `_handleDelegateAsync` so
 * existing gateway.test.js cases that call `gateway._handleDelegateAsync(...)`
 * continue to work unchanged.
 */

const { parseBody } = require('../request-gate');
const { isGenericQueueProbeTask } = require('../../shared/utils');
const { notifyOpenClaw, formatResult } = require('../task-notify');
const { rejectBadRequest } = require('./helpers');

const ROUTES = [
  { method: 'POST', path: '/api/tasks/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate-async', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
];

async function validateDelegateRequest(req, res, ctx) {
  const body = await parseBody(req);
  if (isGenericQueueProbeTask(body && body.task)) {
    ctx._json(req, res, {
      error: 'generic_queue_probe_task_rejected',
      message: 'Do not send queue probe prompts to Trae. Use /api/queue-status, /api/preflight, or wait_task for local waiting.'
    }, 400);
    return;
  }
  if (!body.task) {
    rejectBadRequest(req, res, ctx, 'task is required');
    return;
  }
  if (typeof body.task !== 'string' || body.task.length > 100000) {
    ctx._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
    return;
  }
  return body;
}

function selectFallbackModel(body, ctx) {
  return ctx._normalizeFallbackModels(body.fallbackModels, body.autoModelFallback === true);
}

async function decideQueuePath(body, ctx, fallbackModels) {
  const chatId = body.chatId || null;
  const includeProcessText = body.includeProcessText === true;
  const waitForQueue = body.waitForQueue !== false;
  const modelProbeIntervalMs = ctx._modelProbeIntervalMs(body.modelProbeIntervalMs);
  await ctx._ensureConnection();

  // Get queue status with enhanced detection
  const queueStatus = await ctx.driver.checkQueueStatus();
  const modelProbe = null;
  const queueVisible = queueStatus.queued === true;
  const queueBlocked = queueStatus.running || (queueVisible && queueStatus.canSubmit !== true);
  const shouldBackgroundWait = queueStatus.running || (waitForQueue && queueVisible);

  return { chatId, includeProcessText, waitForQueue, modelProbeIntervalMs, queueStatus, modelProbe, queueVisible, queueBlocked, shouldBackgroundWait };
}

async function handleQueueProbe(req, res, ctx, body, fallbackModels, d) {
  if (!((d.shouldBackgroundWait || d.queueBlocked) && fallbackModels.length > 0)) {
    return d;
  }
  const probeTask = {
    taskId: 'probe_' + Date.now(),
    fallbackModels,
    modelProbeIntervalMs: d.modelProbeIntervalMs,
    nextModelProbeAt: Date.now(),
    modelProbeResults: [],
    currentModel: d.queueStatus.currentModel || null,
    queueState: d.queueStatus.running ? 'running' : (d.queueStatus.queued ? 'queued' : null)
  };
  const modelProbe = await ctx._probeFallbackModels(probeTask, { recordHistory: false });
  if (modelProbe.queueStatus) {
    d.queueStatus = modelProbe.queueStatus;
    d.queueVisible = d.queueStatus.queued === true;
    d.queueBlocked = d.queueStatus.running || (d.queueVisible && d.queueStatus.canSubmit !== true);
    d.shouldBackgroundWait = d.queueStatus.running || (d.waitForQueue && d.queueVisible && d.queueStatus.canSubmit !== true);
  }
  body.fallbackModels = fallbackModels;
  body.modelProbeIntervalMs = d.modelProbeIntervalMs;
  body.initialModelProbeResults = modelProbe.results || [];
  body.initialLastModelProbeAt = probeTask.lastModelProbeAt || null;
  body.initialNextModelProbeAt = probeTask.nextModelProbeAt || null;
  return d;
}

async function awaitBackgroundResult(deps) {
  const { req, res, ctx, body } = deps;
  const queueStatus = deps.queueStatus;
  const queueVisible = deps.queueVisible;
  const queueBlocked = deps.queueBlocked;
  const shouldBackgroundWait = deps.shouldBackgroundWait;
  const waitForQueue = deps.waitForQueue;
  const chatId = deps.chatId;
  const includeProcessText = deps.includeProcessText;

  // Build queue ETA message
  let queueEtaMessage = '';
  if (queueStatus.queueEstimatedWait) {
    queueEtaMessage = `，预计等待 ${queueStatus.queueEstimatedWait}`;
  } else if (queueStatus.queuePosition) {
    queueEtaMessage = `，当前第 ${queueStatus.queuePosition} 位`;
  }

  if (shouldBackgroundWait || queueBlocked) {
    if (!waitForQueue) {
      if (queueVisible && queueStatus.canSubmit === true && !queueStatus.running) {
        // Caller explicitly opted out of local waiting. Let Trae own the queue.
      } else {
      // Caller doesn't want to wait — return queue info immediately
        ctx._json(req, res, {
          status: queueStatus.queued ? 'queued' : 'running',
          queueDetails: {
            state: queueStatus.queued ? 'queued' : 'running',
            currentModel: queueStatus.currentModel || '',
            queuePosition: queueStatus.queuePosition,
            queueEstimatedWait: queueStatus.queueEstimatedWait,
            queueMessage: queueStatus.queueMessage || (queueStatus.running ? '模型正在执行其他任务' : '模型排队中')
          },
          message: `${queueStatus.running ? 'Trae 正在执行其他任务' : '模型排队中'}${queueEtaMessage}，请稍后重试或设置 waitForQueue=true 自动等待`,
          model: queueStatus.currentModel
        }, 202);
        return true;
      }
    }

    if (shouldBackgroundWait) {
      body.chatId = chatId;
      body.includeProcessText = includeProcessText;
      const task = ctx._createQueuedTask(body, queueStatus);
      if (Array.isArray(body.initialModelProbeResults)) {
        task.modelProbeResults = body.initialModelProbeResults;
        task.lastModelProbeAt = body.initialLastModelProbeAt;
        task.nextModelProbeAt = body.initialNextModelProbeAt;
      }
      ctx._ensureBackgroundPolling();

      ctx._json(req, res, {
        taskId: task.taskId,
        status: 'queued',
        queueDetails: {
          state: queueStatus.queued ? 'queued' : 'running',
          currentModel: queueStatus.currentModel || '',
          queuePosition: queueStatus.queuePosition,
          queueEstimatedWait: queueStatus.queueEstimatedWait,
          queueMessage: queueStatus.queueMessage || (queueStatus.running ? '模型正在执行其他任务' : '模型排队中')
        },
        reviewRequired: task.reviewRequired,
        autoContinue: task.autoContinue === true,
        followupCount: task.followupTasks.length,
        modelProbeResults: task.modelProbeResults || [],
        nextModelProbeAt: task.nextModelProbeAt || null,
        message: `${queueStatus.running ? 'Trae 正在执行其他任务' : '模型排队中'}${queueEtaMessage}，任务已加入后台。用 traecn_task_status 查询进度`,
        model: queueStatus.currentModel
      }, 202);
      return true;
    }
  }

  if (body.background === true || body.forceBackground === true) {
    body.chatId = chatId;
    body.includeProcessText = includeProcessText;
    const task = ctx._createQueuedTask(body, {
      ...queueStatus,
      queued: true,
      queueMessage: queueStatus.queueMessage || 'background execution requested'
    });
    if (Array.isArray(body.initialModelProbeResults)) {
      task.modelProbeResults = body.initialModelProbeResults;
      task.lastModelProbeAt = body.initialLastModelProbeAt;
      task.nextModelProbeAt = body.initialNextModelProbeAt;
    }
    ctx._ensureBackgroundPolling();
    ctx._json(req, res, {
      taskId: task.taskId,
      status: 'queued',
      queueDetails: {
        state: 'queued',
        currentModel: queueStatus.currentModel || '',
        queuePosition: queueStatus.queuePosition,
        queueEstimatedWait: queueStatus.queueEstimatedWait,
        queueMessage: task.queueMessage
      },
      reviewRequired: task.reviewRequired,
      autoContinue: task.autoContinue === true,
      followupCount: task.followupTasks.length,
      modelProbeResults: task.modelProbeResults || [],
      nextModelProbeAt: task.nextModelProbeAt || null,
      message: '任务已加入后台执行队列。用 traecn_task_status 查询进度',
      model: queueStatus.currentModel
    }, 202);
    return true;
  }

  return undefined;
}

async function handleDelegateAsync(req, res, ctx) {
  const body = await validateDelegateRequest(req, res, ctx);
  if (body === undefined) return;

  const fallbackModels = selectFallbackModel(body, ctx);
  const d = await decideQueuePath(body, ctx, fallbackModels);
  await handleQueueProbe(req, res, ctx, body, fallbackModels, d);

  const handled = await awaitBackgroundResult({
    req, res, ctx, body,
    chatId: d.chatId,
    includeProcessText: d.includeProcessText,
    waitForQueue: d.waitForQueue,
    queueStatus: d.queueStatus,
    queueVisible: d.queueVisible,
    queueBlocked: d.queueBlocked,
    shouldBackgroundWait: d.shouldBackgroundWait
  });
  if (handled) return;

  const chatId = d.chatId;
  const includeProcessText = d.includeProcessText;

  // Model is idle/ready — execute synchronously with timeout protection
  if (!ctx.driver) {
    return ctx._json(req, res, { error: 'CDP driver not available — connection may have failed' }, 503);
  }

  let result;
  let timeoutId;
  let delegatePromise;
  try {
    const syncTimeout = 180000;
    const timeoutPromise = new Promise((_, reject) =>
      { timeoutId = ctx._setTimeout(() => reject(new Error('delegate timeout (' + syncTimeout + 'ms)')), syncTimeout); }
    );
    delegatePromise = ctx.driver.delegate(ctx._taskWithProjectContext(body.task, body.projectPath));
    result = await Promise.race([delegatePromise, timeoutPromise]);
  } catch (e) {
    if (/delegate timeout/i.test(e.message || '') && delegatePromise) {
      const normalizedFollowups = ctx._normalizeFollowupTasks(body.followupTasks);
      const task = ctx._createQueuedTask({
        task: body.task,
        projectPath: body.projectPath,
        reviewRequired: body.reviewRequired === true,
        autoContinue: body.autoContinue === true,
        followupTasks: normalizedFollowups,
        autoApproveDialog: body.autoApproveDialog,
        chatId,
        includeProcessText,
        notifyUrl: body.notifyUrl
      }, {
        queued: true,
        running: false,
        queueMessage: 'sync delegate timed out; tracking submitted Trae request in background'
      });
      task.status = 'executing';
      task.submittedToTrae = true;
      task.submittedAt = Date.now();
      task.error = null;
      ctx.taskQueueService.tryAcquire(task.taskId);
      await ctx._captureTaskSoloChat(task);
      ctx._syncTaskHistoryMirror(task);
      ctx._persistActiveQueue();

      delegatePromise
        .then(async (resolvedResult) => {
          const liveTask = ctx.taskQueue.get(task.taskId);
          if (!liveTask || ctx._isTerminalTaskStatus(liveTask.status)) return;
          await ctx._finalizeCollectedBackgroundResult(task.taskId, liveTask, resolvedResult);
        })
        .catch(async (err) => {
          const liveTask = ctx.taskQueue.get(task.taskId);
          if (!liveTask || ctx._isTerminalTaskStatus(liveTask.status)) return;
          if (await ctx._retryBackgroundTaskAfterError(task.taskId, liveTask, err)) {
            return;
          }
          await ctx._finalizeBackgroundTask(task.taskId, liveTask, 'error', {
            error: err.message
          });
        })
        .finally(() => {
          ctx.taskQueueService.release(task.taskId);
        });

      return ctx._json(req, res, {
        taskId: task.taskId,
        status: task.status,
        submittedToTrae: true,
        reviewRequired: task.reviewRequired,
        followupCount: task.followupTasks.length,
        message: 'Trae 请求已提交但同步等待超时，已自动转入后台追踪。用 traecn_task_status 查询进度'
      }, 202);
    }
    const recoveredResult = await ctx._recoverAwaitingReviewFromGate({
      createdAt: Date.now(),
      followupTasks: ctx._normalizeFollowupTasks(body.followupTasks),
      autoApproveDialog: body.autoApproveDialog,
      reviewRequired: body.reviewRequired === true,
      autoContinue: body.autoContinue === true
    });
    if (recoveredResult) {
      const normalizedFollowups = ctx._normalizeFollowupTasks(body.followupTasks);
      const task = ctx._createQueuedTask({
        task: body.task,
        projectPath: body.projectPath,
        reviewRequired: body.reviewRequired === true,
        autoContinue: body.autoContinue === true,
        followupTasks: normalizedFollowups,
        autoApproveDialog: body.autoApproveDialog,
        chatId,
        includeProcessText,
        notifyUrl: body.notifyUrl
      }, { queued: false, running: false, queueMessage: 'recovered from review gate' });
      await ctx._finalizeCollectedBackgroundResult(task.taskId, task, recoveredResult);
      return ctx._json(req, res, {
        taskId: task.taskId,
        status: task.status,
        reviewRequired: task.reviewRequired,
        followupCount: task.followupTasks.length,
        message: 'Trae 已生成结果，但当前停在内部审查闸口；任务已恢复为等待审查',
        resultPreview: (recoveredResult.text || '').slice(0, 500)
      }, 202);
    }
    return ctx._json(req, res, { error: 'delegate failed: ' + e.message }, 504);
  } finally {
    if (timeoutId) ctx._clearTimeout(timeoutId);
  }

  if (chatId) {
    await notifyOpenClaw(chatId, formatResult(result), '[Delegate] OpenClaw notify failed:');
  }

  const responseData = {
    status: ctx._isSuccessfulResult(result) ? 'done' : 'error',
    text: result.text,
    stable: result.stable,
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut || false,
    needsApproval: result.needsApproval || false,
    question: result.question || '',
    error: ctx._isSuccessfulResult(result) ? undefined : (result.error || 'Trae returned an incomplete, timed-out, or failed result')
  };

  if (body.reviewRequired === true || ctx._normalizeFollowupTasks(body.followupTasks).length > 0) {
    const normalizedFollowups = ctx._normalizeFollowupTasks(body.followupTasks);
    const task = ctx._createQueuedTask({
      task: body.task,
      projectPath: body.projectPath,
      reviewRequired: body.reviewRequired === true,
      autoContinue: body.autoContinue === true,
      followupTasks: normalizedFollowups,
      autoApproveDialog: body.autoApproveDialog,
      chatId,
      includeProcessText,
      notifyUrl: body.notifyUrl
    }, { queued: false, running: false, queueMessage: 'immediate execution' });
    task.submittedToTrae = true;
    task.submittedAt = Date.now();
    task.queueState = 'running';
    await ctx._finalizeCollectedBackgroundResult(task.taskId, task, result);
    return ctx._json(req, res, {
      taskId: task.taskId,
      status: task.status,
      reviewRequired: task.reviewRequired,
      followupCount: task.followupTasks.length,
      message: task.status === 'approval_required'
        ? 'Trae 结果需要先处理确认弹窗'
        : (task.status === 'awaiting_review'
            ? 'Trae 已完成，等待人工审查'
            : (task.status === 'executing'
                ? 'Trae 已返回过程文本，任务已转入后台继续收集。用 traecn_task_status 查询进度'
                : 'Trae 返回了不完整或超时结果，未进入审查')),
      resultPreview: (result.text || '').slice(0, 500)
    }, task.status === 'error' ? 504 : 202);
  }

  if (includeProcessText && result.processText) {
    responseData.processText = result.processText;
  }

  ctx._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 200 });
  ctx._json(req, res, responseData);
}

module.exports = { ROUTES, handleDelegateAsync };
