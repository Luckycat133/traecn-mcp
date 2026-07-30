'use strict';

const { parseBody } = require('../request-gate');
const { buildConfirmationPlan } = require('../../shared/operation-confirmation');
const { getEnvWithFallback } = require('../../shared/utils');
const { discoverTarget, describeCDPSurface } = require('../../cdp/discovery');
const { getQuickstartConfig, restartTraeCNWithDebug } = require('../../config/quickstart');
const { rejectBadRequest, hasDriverCapability } = require('./helpers');
const { conversationId } = require('./unified-agent');

const defaultRestartDebugDeps = {
  getEnvWithFallback,
  discoverTarget,
  describeCDPSurface,
  getQuickstartConfig,
  restartTraeCNWithDebug
};
let restartDebugDeps = defaultRestartDebugDeps;

function setRestartDebugDepsForTest(overrides = null) {
  restartDebugDeps = overrides ? { ...defaultRestartDebugDeps, ...overrides } : defaultRestartDebugDeps;
}

/**
 * trae-control handlers.
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
      "path": "/api/trae/stop-generation",
      "handler": "_handleStopGeneration",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/trae/restart-debug",
      "handler": "_handleRestartTraeDebug",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "GET",
      "path": "/api/trae/review-gate",
      "handler": "_handleReviewGateStatus",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "POST",
      "path": "/api/trae/review-gate",
      "handler": "_handleReviewGateResolve",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "GET",
      "path": "/api/detect-mode",
      "handler": "_handleDetectMode",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": false
    },
    {
      "method": "POST",
      "path": "/api/switch-mode",
      "handler": "_handleSwitchMode",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/switch-model",
      "handler": "_handleSwitchModel",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    }
  ];

async function handleStopGeneration(req, res, ctx) {
  const body = await parseBody(req);
  const requestedConversationId = String(body.conversationId || '').trim();
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (body.acknowledgeUntrackedWork !== true) {
    return ctx._json(req, res, {
      error: 'untracked_work_acknowledgement_required',
      message: 'Visible generation may belong to the user or another agent.'
    }, 400);
  }
  if (!requestedConversationId || !reason || reason.length > 500) {
    return ctx._json(req, res, {
      error: 'conversationId and a reason of 1-500 characters are required'
    }, 400);
  }
  await ctx._ensureConnection();
  const run = typeof ctx._withUiActionLock === 'function'
    ? operation => ctx._withUiActionLock(operation)
    : operation => operation();
  return run(async () => {
    const mode = typeof ctx.driver.detectMode === 'function'
      ? (await ctx.driver.detectMode())?.mode
      : null;
    if (mode !== 'solo' || typeof ctx.driver.listSoloChats !== 'function') {
      return ctx._json(req, res, {
        error: 'scoped_stop_requires_solo_conversation',
        message: 'Use traecn_cancel_task for gateway-tracked work; untracked stop requires a stable Solo conversation ID.'
      }, 409);
    }
    const listed = await ctx.driver.listSoloChats();
    const active = (listed.chats || []).find(chat => chat.active === true);
    const activeConversationId = active ? conversationId(active) : null;
    if (!activeConversationId || activeConversationId !== requestedConversationId) {
      if (ctx.auditLogger && typeof ctx.auditLogger.log === 'function') {
        ctx.auditLogger.log({
          req,
          action: 'trae.stop_generation',
          resource: requestedConversationId,
          params: { activeConversationId, reason },
          status: 'failure',
          error: 'active_conversation_mismatch'
        });
      }
      return ctx._json(req, res, {
        error: 'active_conversation_mismatch',
        requestedConversationId,
        activeConversationId
      }, 409);
    }
    const result = hasDriverCapability(ctx, 'stopGeneration')
      ? await ctx.driver.stopGeneration()
      : { success: false, reason: 'driver_does_not_support_stop_generation' };
    if (ctx.auditLogger && typeof ctx.auditLogger.log === 'function') {
      ctx.auditLogger.log({
        req,
        action: 'trae.stop_generation',
        resource: requestedConversationId,
        params: { reason, acknowledgedUntrackedWork: true },
        status: result.success === false ? 'failure' : 'success',
        error: result.success === false ? result.reason || result.error || 'stop_failed' : null
      });
    }
    return ctx._json(req, res, {
      ...result,
      conversationId: requestedConversationId,
      scope: 'active_solo_conversation'
    }, result.success === false ? 409 : 200);
  });
}
async function handleRestartTraeDebug(req, res, ctx) {
  const body = await parseBody(req);
  const expectedPhrase = 'restart-trae-cn-with-debug-existing-profile';
  const plan = buildConfirmationPlan({
    command: 'restart_trae_debug',
    params: {
      projectPath: body.projectPath || null,
      profileMode: 'existing'
    },
    forceConfirm: true
  });
  const confirmed = body.confirmationPhrase === expectedPhrase || body.confirmationId === plan.confirmationId;
  if (!confirmed) {
    return ctx._json(req, res, {
      error: 'Explicit confirmation required before restarting Trae CN',
      confirmationId: plan.confirmationId,
      plan
    }, 409);
  }

  if (ctx.client) {
    try {
      await ctx.client.close();
    } catch {
      // Closing an already-dead CDP client is non-fatal before restart.
    }
    ctx.client = null;
    ctx.driver = null;
  }

  const quickstart = restartDebugDeps.getQuickstartConfig();
  const requestedPort = restartDebugDeps.getEnvWithFallback(
    'TRAECN_REMOTE_DEBUGGING_PORT',
    'TRAE_REMOTE_DEBUGGING_PORT',
    quickstart.remoteDebuggingPort || '9334'
  );
  process.env.TRAECN_REMOTE_DEBUGGING_PORT = requestedPort;

  let restart;
  try {
    restart = await restartDebugDeps.restartTraeCNWithDebug({
      projectPath: body.projectPath,
      quitTimeoutMs: body.quitTimeoutMs,
      pollMs: body.pollMs
    });
  } catch (err) {
    return ctx._json(req, res, {
      ok: false,
      error: err.message,
      profileMode: 'existing',
      requestedPort
    }, 500);
  }

  const cdpWaitMs = Number.isFinite(Number(body.cdpWaitMs)) ? Number(body.cdpWaitMs) : 60000;
  const startedAt = Date.now();
  let connected = false;
  let surface = null;
  let lastError = null;
  while (Date.now() - startedAt < cdpWaitMs) {
    try {
      surface = await restartDebugDeps.discoverTarget();
      connected = true;
      break;
    } catch (err) {
      lastError = err.message;
      await new Promise(resolve => { ctx._setTimeout(resolve, 1000); });
    }
  }

  ctx._json(req, res, {
    ok: connected,
    action: 'restart_trae_debug',
    profileMode: 'existing',
    requestedPort,
    restart,
    cdpWaitMs,
    connected,
    surface: surface ? restartDebugDeps.describeCDPSurface([surface.target || surface]) : null,
    error: connected ? null : (lastError || 'Timed out waiting for CDP')
  }, connected ? 200 : 504);
}
async function handleReviewGateStatus(req, res, ctx) {
  await ctx._ensureConnection();
  const result = hasDriverCapability(ctx, 'checkTaskReviewGate')
    ? await ctx.driver.checkTaskReviewGate()
    : { awaitingReview: false, reason: 'driver_does_not_support_review_gate' };
  ctx._json(req, res, result);
}
async function handleReviewGateResolve(req, res, ctx) {
  const body = await parseBody(req);
  const action = body.action || 'keep_all';
  if (!['keep_all', 'revert_all', 'keep', 'discard'].includes(action)) {
    return ctx._json(req, res, { error: 'action must be keep_all or revert_all' }, 400);
  }
  await ctx._ensureConnection();
  const normalizedAction = action === 'keep' ? 'keep_all' : (action === 'discard' ? 'revert_all' : action);
  const result = hasDriverCapability(ctx, 'resolveTaskReviewGate')
    ? await ctx.driver.resolveTaskReviewGate(normalizedAction)
    : { success: false, reason: 'driver_does_not_support_review_gate' };
  ctx._json(req, res, result, result.success === false ? 409 : 200);
}
async function handleDetectMode(req, res, ctx) {
  await ctx._ensureConnection();
  const modeInfo = await ctx.driver.detectMode();
  ctx._json(req, res, {
    mode: modeInfo.mode,
    confidence: modeInfo.confidence,
    indicators: modeInfo.indicators
  });
}
async function handleSwitchMode(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.mode) {
    return rejectBadRequest(req, res, ctx, 'mode is required');
  }
  if (!['solo', 'ide'].includes(body.mode.toLowerCase())) {
    return ctx._json(req, res, { error: 'mode must be "solo" or "ide"' }, 400);
  }

  await ctx._ensureConnection();
  const result = await ctx.driver.switchMode(body.mode);
  ctx._json(req, res, {
    success: result.success,
    mode: body.mode,
    previousMode: result.previousMode || null,
    alreadyInMode: result.alreadyInMode || false
  });
}
async function handleSwitchModel(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.model) {
    return rejectBadRequest(req, res, ctx, 'model is required');
  }

  await ctx._ensureConnection();
  const switchResult = await ctx.driver.switchModel(body.model);
  const normalizedSwitch = ctx._normalizeModelSwitchResult(switchResult);

  if (!normalizedSwitch.success) {
    return ctx._json(req, res, {
      success: false,
      model: normalizedSwitch.model || null,
      requestedModel: body.model,
      switchResult: normalizedSwitch.switchResult || switchResult,
      error: normalizedSwitch.error || 'Model switch failed'
    }, 502);
  }

  if (body.waitForQueue === false) {
    const status = await ctx.driver.checkQueueStatus();
    return ctx._json(req, res, {
      success: true,
      model: normalizedSwitch.model || body.model,
      requestedModel: body.model,
      switchResult: normalizedSwitch.switchResult || switchResult,
      previousModel: normalizedSwitch.previousModel || null,
      alreadySelected: normalizedSwitch.alreadySelected || false,
      queued: status.queued === true,
      running: status.running === true,
      canSubmit: status.canSubmit === true,
      queueDetails: ctx._queueDetailsFromStatus(status, normalizedSwitch.model || body.model)
    });
  }

  // Wait for model to become available (up to 10 minutes)
  const queueWaitTimeoutMs = ctx.driver.config.queueWaitTimeoutMs || 600000;
  const queuePollIntervalMs = ctx.driver.config.queuePollIntervalMs || 15000;
  const maxRetries = Math.ceil(queueWaitTimeoutMs / queuePollIntervalMs);

  let waitedMs = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const status = await ctx.driver.checkQueueStatus();
    if (!status.queued) {
      // Model is ready
      return ctx._json(req, res, {
        success: true,
        model: normalizedSwitch.model || body.model,
        requestedModel: body.model,
        switchResult: normalizedSwitch.switchResult || switchResult,
        previousModel: normalizedSwitch.previousModel || null,
        alreadySelected: normalizedSwitch.alreadySelected || false,
        queueWaitMs: waitedMs,
        queueWaitAttempts: attempt
      });
    }

    // Still queued — wait and retry
    await new Promise(r => { ctx._setTimeout(r, queuePollIntervalMs); });
    waitedMs += queuePollIntervalMs;
  }

  // Timed out waiting for model to become available
  return ctx._json(req, res, {
    success: false,
    model: normalizedSwitch.model || body.model,
    requestedModel: body.model,
    switchResult: normalizedSwitch.switchResult || switchResult,
    error: 'Model queue wait timeout',
    queueWaitMs: waitedMs,
    queueWaitAttempts: maxRetries
  }, 504);
}

module.exports = {
  ROUTES,
  handleStopGeneration,
  handleRestartTraeDebug,
  handleReviewGateStatus,
  handleReviewGateResolve,
  handleDetectMode,
  handleSwitchMode,
  handleSwitchModel,
  setRestartDebugDepsForTest
};
