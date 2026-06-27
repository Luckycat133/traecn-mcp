'use strict';

const { parseBody } = require('../request-gate');

/**
 * sessions handlers.
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
      "path": "/api/sessions",
      "handler": "_handleCreateSession",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "GET",
      "path": "/api/sessions",
      "handler": "_handleListSessions",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/sessions/:sessionId",
      "handler": "_handleGetSession",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false,
      "pathParams": [
        "sessionId"
      ]
    },
    {
      "method": "POST",
      "path": "/api/sessions/:sessionId/delegate",
      "handler": "_handleDelegate",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true,
      "pathParams": [
        "sessionId"
      ]
    }
  ];

async function handleCreateSession(req, res, ctx) {
  const body = await parseBody(req);
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await ctx._ensureConnection();

  const session = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    projectPath: body.projectPath || null,
    messages: []
  };

  ctx.sessions.set(sessionId, session);

  const responseData = { sessionId, createdAt: session.createdAt };
  ctx._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 201 });
  ctx._json(req, res, responseData, 201);
}
function handleListSessions(req, res, ctx) {
  const sessions = Array.from(ctx.sessions.values()).map(s => ({
    id: s.id,
    createdAt: s.createdAt,
    messageCount: s.messages.length
  }));
  ctx._json(req, res, { sessions });
}
function handleGetSession(req, res, ctx, sessionId) {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    return ctx._json(req, res, { error: 'Session not found' }, 404);
  }
  ctx._json(req, res, session);
}
async function handleDelegate(req, res, ctx, sessionId) {
  const body = await parseBody(req);
  if (!body.task) {
    return ctx._json(req, res, { error: 'task is required' }, 400);
  }
  if (typeof body.task !== 'string' || body.task.length > 100000) {
    return ctx._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
  }

  await ctx._ensureConnection();

  const session = ctx.sessions.get(sessionId);
  if (session) {
    session.messages.push({ role: 'user', content: body.task, timestamp: new Date().toISOString() });
  }

  const queueStatus = typeof ctx.driver.checkQueueStatus === 'function'
    ? await ctx.driver.checkQueueStatus()
    : { queued: false, running: false, canSubmit: true };
  const waitForQueue = body.waitForQueue !== false;
  const queueVisible = queueStatus.queued === true;
  const queueBlocked = queueStatus.running === true || (queueVisible && queueStatus.canSubmit !== true);
  if (queueBlocked || (waitForQueue && queueVisible)) {
    if (!waitForQueue) {
      return ctx._json(req, res, {
        status: queueStatus.queued ? 'queued' : 'running',
        queueDetails: ctx._queueDetailsFromStatus(queueStatus),
        message: queueStatus.running ? 'Trae 正在执行其他任务' : '模型排队中'
      }, 202);
    }

    const task = ctx._createQueuedTask({
      task: body.task,
      projectPath: body.projectPath,
      reviewRequired: body.reviewRequired === true,
      autoContinue: body.autoContinue === true,
      followupTasks: body.followupTasks,
      completionChecks: body.completionChecks,
      autoApproveDialog: body.autoApproveDialog,
      includeProcessText: body.includeProcessText === true,
      notifyUrl: body.notifyUrl,
      chatId: body.chatId
    }, queueStatus);
    ctx._ensureBackgroundPolling();
    return ctx._json(req, res, {
      taskId: task.taskId,
      status: 'queued',
      queueDetails: ctx._queueDetailsFromStatus(queueStatus, task.currentModel),
      reviewRequired: task.reviewRequired,
      autoContinue: task.autoContinue === true,
      followupCount: task.followupTasks.length,
      message: '模型排队中，任务已加入后台。用 traecn_task_status 查询进度',
      model: queueStatus.currentModel || null
    }, 202);
  }

  const result = await ctx.driver.delegate(ctx._taskWithProjectContext(body.task, body.projectPath));

  if (session) {
    session.messages.push({ role: 'assistant', content: result.text, timestamp: new Date().toISOString() });
  }

  const responseData = {
    text: result.text,
    stable: result.stable,
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut || false
  };

  if (body.includeProcessText) {
    responseData.processText = result.text;
  }

  ctx._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 200 });
  ctx._json(req, res, responseData);
}

module.exports = { ROUTES, handleCreateSession, handleListSessions, handleGetSession, handleDelegate };