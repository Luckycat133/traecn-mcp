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
const discovery = require('../../cdp/discovery');

const ROUTES = [
  { method: 'POST', path: '/api/tasks/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/delegate-async', handler: '_handleDelegateAsync', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
];

const { notifyOpenClaw, formatResult } = require('../notifications');

async function handleDelegateAsync(req, res, ctx) {
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

  const chatId = body.chatId || null;
  const includeProcessText = body.includeProcessText === true;
  const waitForQueue = body.waitForQueue !== false;
  const fallbackModels = ctx._normalizeFallbackModels(body.fallbackModels, body.autoModelFallback === true);
  const modelProbeIntervalMs = ctx._modelProbeIntervalMs(body.modelProbeIntervalMs);
  await ctx._ensureConnection();
  await ctx._assertProjectWorkspace(body.projectPath);

  // Honest gate: a stale but still-OPEN CDP WebSocket can report isConnected
  // while the underlying Trae browser is actually gone, so _ensureConnection
  // may skip reconnection and driver.delegate would hand back a false
  // "ok: true / unstable" result. Re-verify the CDP endpoint is truly
  // reachable before delegating. The mock bridge skips this (tests/CI).
  if (!ctx.mockBridge) {
    try {
      await discovery.resolveCDPEndpoint();
    } catch (cdpErr) {
      return ctx._json(req, res, {
        ok: false,
        error: 'CONNECTION_FAILED',
        code: 'CDP_NOT_CONNECTED',
        message: 'TraeCN CDP is not reachable: ' + (cdpErr && cdpErr.message ? cdpErr.message : String(cdpErr))
      }, 503);
    }
  }

  // Get queue status with enhanced detection
  let queueStatus = await ctx.driver.checkQueueStatus();
  let modelProbe;
  let queueVisible = queueStatus.queued === true;
  let queueBlocked = queueStatus.running || (queueVisible && queueStatus.canSubmit !== true);
  let shouldBackgroundWait = queueStatus.running || (waitForQueue && queueVisible);

  if ((shouldBackgroundWait || queueBlocked) && fallbackModels.length > 0) {
    const probeTask = {
      taskId: 'probe_' + Date.now(),
      fallbackModels,
      modelProbeIntervalMs,
      nextModelProbeAt: Date.now(),
      modelProbeResults: [],
      currentModel: queueStatus.currentModel || null,
      queueState: queueStatus.running ? 'running' : (queueStatus.queued ? 'queued' : null)
    };
    modelProbe = await ctx._probeFallbackModels(probeTask, { recordHistory: false });
    if (modelProbe.queueStatus) {
      queueStatus = modelProbe.queueStatus;
      queueVisible = queueStatus.queued === true;
      queueBlocked = queueStatus.running || (queueVisible && queueStatus.canSubmit !== true);
      shouldBackgroundWait = queueStatus.running || (waitForQueue && queueVisible && queueStatus.canSubmit !== true);
    }
    body.fallbackModels = fallbackModels;
    body.modelProbeIntervalMs = modelProbeIntervalMs;
    body.initialModelProbeResults = modelProbe.results || [];
    body.initialLastModelProbeAt = probeTask.lastModelProbeAt || null;
    body.initialNextModelProbeAt = probeTask.nextModelProbeAt || null;
  }

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
        return ctx._json(req, res, {
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

      return ctx._json(req, res, {
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
    return ctx._json(req, res, {
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
  }

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
    delegatePromise = ctx.driver.delegate(body.task);
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
    await notifyOpenClaw(chatId, formatResult(result));
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
