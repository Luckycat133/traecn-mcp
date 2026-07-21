'use strict';

const { parseBody } = require('../request-gate');
const { isGenericQueueProbeTask } = require('../../shared/utils');
const { rejectBadRequest, hasDriverCapability, requireDriverCapability } = require('./helpers');

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
    },
    {
      "method": "POST",
      "path": "/api/solo/chats/delete",
      "handler": "_handleDeleteSoloChats",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/solo/chats/cleanup-foreign-queue",
      "handler": "_handleCleanupForeignQueue",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/solo/chats/cleanup_foreign_solo_queue",
      "handler": "_handleCleanupForeignQueue",
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
  const result = hasDriverCapability(ctx, 'listSoloChats')
    ? await ctx.driver.listSoloChats()
    : { mode: 'unsupported', chats: [], count: 0, reason: 'driver_does_not_support_solo_chats' };
  ctx._json(req, res, result);
}
async function handleSwitchSoloChat(req, res, ctx) {
  const body = await parseBody(req);
  await ctx._ensureConnection();
  const result = hasDriverCapability(ctx, 'switchSoloChat')
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
    return rejectBadRequest(req, res, ctx, 'task is required');
  }
  if (typeof body.task !== 'string' || body.task.length > 100000) {
    return ctx._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
  }

  return await ctx._withUiActionLock(async () => {
    await ctx._ensureConnection();
    if (hasDriverCapability(ctx, 'switchMode')) {
      await ctx.driver.switchMode('solo');
    }
    if (!requireDriverCapability(req, res, ctx, 'sendMessage', 'driver does not support message submission')) {
      return;
    }

    const requestedSoloChat = ctx._normalizeSoloChatTarget(body.soloChat || body.soloChatTarget || {
      index: body.soloChatIndex,
      titleIncludes: body.soloChatTitleIncludes,
      textIncludes: body.soloChatTextIncludes
    });

    if (requestedSoloChat) {
      if (!requireDriverCapability(req, res, ctx, 'switchSoloChat', undefined, { success: false, reason: 'driver_does_not_support_solo_chats' })) {
        return;
      }
      const switchResult = await ctx.driver.switchSoloChat(ctx._soloChatSwitchCriteria(requestedSoloChat));
      if (switchResult.success === false) {
        return ctx._json(req, res, switchResult, 404);
      }
    } else if (body.newChat !== false) {
      if (!requireDriverCapability(req, res, ctx, 'newChat', 'driver does not support new chat creation')) {
        return;
      }
      await ctx.driver.newChat();
    }

    await ctx.driver.sendMessage(ctx._taskWithProjectContext(body.task, body.projectPath));
    const queueStatus = hasDriverCapability(ctx, 'checkQueueStatus')
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
async function handleDeleteSoloChats(req, res, ctx) {
  const body = await parseBody(req);
  const dryRun = body.dryRun === true;
  const candidatesIn = Array.isArray(body.candidates) ? body.candidates : [];
  // Auto-discover queue-probe spam when no candidates given.
  let candidates = candidatesIn;
  if (candidates.length === 0) {
    await ctx._ensureConnection();
    const listed = hasDriverCapability(ctx, 'listSoloChats')
      ? await ctx.driver.listSoloChats()
      : { mode: 'unsupported', chats: [], count: 0 };
    if (!Array.isArray(listed.chats)) {
      return ctx._json(req, res, {
        error: 'solo_chats_unavailable',
        mode: listed.mode,
        reason: listed.reason || 'no_chats_returned'
      }, 404);
    }
    candidates = listed.chats
      .filter(c => typeof c.title === 'string' && isQueueProbeChatTitle(c.title))
      .map(c => ({ index: c.index, title: c.title }));
  }
  // Sanitize candidates: only allow {index:number, title:string}
  candidates = candidates
    .map(c => ({
      index: Number.isInteger(c && c.index) ? c.index : null,
      title: typeof (c && c.title) === 'string' ? c.title : ''
    }))
    .filter(c => c.index !== null && c.title);

  if (candidates.length === 0) {
    return ctx._json(req, res, {
      deleted: 0,
      attempted: 0,
      dryRun,
      candidates: [],
      message: 'no candidates to delete'
    });
  }

  if (dryRun) {
    return ctx._json(req, res, {
      deleted: 0,
      attempted: candidates.length,
      dryRun: true,
      candidates,
      message: `dryRun=true; would attempt to delete ${candidates.length} candidate(s)`
    });
  }

  await ctx._ensureConnection();
  if (!requireDriverCapability(req, res, ctx, 'deleteSoloChats', 'driver_does_not_support_delete_solo_chats')) {
    return;
  }
  const result = await ctx.driver.deleteSoloChats({ candidates });
  return ctx._json(req, res, {
    deleted: result.deleted,
    attempted: candidates.length,
    dryRun: false,
    attempts: result.attempts,
    message: result.deleted === candidates.length
      ? `deleted ${result.deleted}/${candidates.length} candidate(s)`
      : `deleted ${result.deleted}/${candidates.length}; see attempts[] for failures`
  }, result.deleted === candidates.length ? 200 : 207);
}

function isQueueProbeChatTitle(title) {
  if (typeof title !== 'string') return false;
  const t = title.toLowerCase();
  return t.includes('wait for trae queue')
    || t.includes('wait for queue')
    || /^\s*queue\s*(probe|status|wait)/i.test(t);
}

function isForeignQueueConversation(chat) {
  if (!chat || typeof chat !== 'object') return false;
  return isGenericQueueProbeTask(chat.title) || isGenericQueueProbeTask(chat.text);
}

function extractForeignSoloChatCandidates(soloChatsResult) {
  const result = (soloChatsResult && typeof soloChatsResult === 'object')
    ? soloChatsResult
    : { mode: 'unknown', chats: [], count: 0, reason: 'solo_chats_unavailable' };
  const chats = Array.isArray(result.chats) ? result.chats : [];
  const candidates = chats.filter(isForeignQueueConversation)
    .map(chat => ({
      index: chat.index,
      title: chat.title || '',
      text: chat.text || '',
      status: chat.status || null,
      active: !!chat.active
    }));
  return {
    mode: result.mode || 'unknown',
    reason: result.reason || (candidates.length === 0 ? 'none_found' : null),
    count: chats.length,
    candidates
  };
}

function isRetryableCdpError(err, ctx) {
  const message = String(err && err.message ? err.message : err || '').toLowerCase();
  return message.includes('client is undefined')
    || message.includes('client is null')
    || message.includes('cannot read properties of undefined')
    || message.includes('target has no web socket debugger url')
    || message.includes('connection')
    || !ctx.client
    || !ctx.client.isConnected;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listCleanupCandidates(ctx) {
  let listResult = null;
  try {
    listResult = await ctx.driver.listSoloChats();
  } catch (err) {
    const retryable = isRetryableCdpError(err, ctx);
    return {
      error: {
        body: {
          error: 'Failed to list Solo chats during cleanup',
          code: retryable ? 'CDP_DRIVER_NOT_READY' : 'SOLO_LIST_FAILED',
          retryable,
          details: err.message,
          ready: !!(ctx.client && ctx.client.isConnected)
        },
        status: retryable ? 503 : 500
      }
    };
  }
  return { match: extractForeignSoloChatCandidates(listResult) };
}

async function handleCleanupForeignQueue(req, res, ctx) {
  const body = await parseBody(req);
  try {
    await ctx._ensureConnection();
  } catch (err) {
    const retryable = isRetryableCdpError(err, ctx);
    return ctx._json(req, res, {
      error: 'Failed to ensure CDP connection for cleanup',
      code: retryable ? 'CDP_DRIVER_NOT_READY' : 'CDP_CONNECTION_ERROR',
      retryable,
      details: String(err && err.message ? err.message : 'unknown error')
    }, retryable ? 503 : 500);
  }

  if (!ctx.driver) {
    return ctx._json(req, res, {
      error: 'CDP driver not initialized; TraeCN may not be reachable',
      code: 'CDP_DRIVER_MISSING',
      ready: false
    }, 503);
  }

  if (!requireDriverCapability(req, res, ctx, 'listSoloChats', 'driver does not support listSoloChats')) {
    return;
  }

  const executeDelete = body.execute === true && body.dryRun !== true;
  const maxPasses = executeDelete ? clampInt(body.maxPasses, 1, 1, 20) : 1;
  const settleMs = clampInt(body.settleMs, 250, 0, 5000);
  const support = hasDriverCapability(ctx, 'deleteSoloChats') ? 'delete_supported' : 'delete_unsupported';
  const first = await listCleanupCandidates(ctx);
  if (first.error) {
    return ctx._json(req, res, first.error.body, first.error.status);
  }

  if (!executeDelete) {
    return ctx._json(req, res, {
      mode: first.match.mode,
      reason: first.match.reason,
      matched: first.match.candidates.length,
      total: first.match.count,
      candidates: first.match.candidates,
      support,
      deleted: 0,
      dryRun: true,
      message: 'Dry-run cleanup result. Set { "execute": true } to attempt deletion.'
    }, 200);
  }

  if (!requireDriverCapability(req, res, ctx, 'deleteSoloChats', 'driver does not support deleteSoloChats', {
    code: 'DRIVER_METHOD_MISSING',
    candidates: first.match.candidates,
    message: 'Matched candidates are listed above; delete is not supported by current driver.'
  })) {
    return;
  }

  const passes = [];
  let deleted = 0;
  let latest = first.match;
  for (let pass = 1; pass <= maxPasses; pass++) {
    if (pass > 1) {
      const next = await listCleanupCandidates(ctx);
      if (next.error) {
        return ctx._json(req, res, next.error.body, next.error.status);
      }
      latest = next.match;
    }
    if (latest.candidates.length === 0) break;

    let deleteResult;
    try {
      deleteResult = await ctx.driver.deleteSoloChats({ candidates: latest.candidates });
    } catch (err) {
      const retryable = isRetryableCdpError(err, ctx);
      return ctx._json(req, res, {
        error: 'Failed to delete Solo chats during cleanup',
        code: retryable ? 'CDP_DRIVER_NOT_READY' : 'SOLO_DELETE_FAILED',
        retryable,
        details: err.message,
        ready: !!(ctx.client && ctx.client.isConnected),
        candidates: latest.candidates
      }, retryable ? 503 : 500);
    }

    const passDeleted = Number(deleteResult && deleteResult.deleted) || 0;
    deleted += passDeleted;
    passes.push({
      pass,
      matched: latest.candidates.length,
      deleted: passDeleted,
      attempts: Array.isArray(deleteResult && deleteResult.attempts) ? deleteResult.attempts : []
    });

    if (passDeleted === 0 || pass >= maxPasses) break;
    if (settleMs > 0) await sleep(settleMs);
  }

  return ctx._json(req, res, {
    mode: first.match.mode,
    reason: first.match.reason,
    matched: first.match.candidates.length,
    total: first.match.count,
    candidates: first.match.candidates,
    support,
    deleted,
    dryRun: false,
    passes,
    message: deleted > 0
      ? `Cleanup deleted ${deleted} queue-probe Solo chat(s).`
      : 'Cleanup found no deletable queue-probe Solo chats.'
  }, 200);
}

module.exports = {
  ROUTES,
  handleNewChat,
  handleListSoloChats,
  handleSwitchSoloChat,
  handleSubmitSoloChatTask,
  handleDeleteSoloChats,
  handleCleanupForeignQueue
};
