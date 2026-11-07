'use strict';

const { parseBody } = require('../request-gate');
const { isGenericQueueProbeTask } = require('../../shared/utils');
const { TraeCNAutomationError } = require('../../cdp/errors');
const { isKnownStandaloneAgentVersion } = require('../../trae-adapters/registry');

const ROUTES = [
  { method: 'POST', path: '/api/tasks/submit', handler: '_handleUnifiedSubmit', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/models', handler: '_handleListModels', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'GET', path: '/api/conversations', handler: '_handleListConversations', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/conversations/manage', handler: '_handleManageConversation', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/interactions/resolve', handler: '_handleResolveInteraction', requiresAuth: true, requiresRateLimit: true, requiresBody: true }
];

const SAFE_STANDALONE_DELETE_FAILURES = new Set([
  'candidate_not_found', 'candidate_not_located', 'sidebar_element_not_found', 'sidebar_not_visible',
  'sidebar_scan_timeout', 'sidebar_scan_incomplete', 'standalone_agent_identity_required',
  'standalone_agent_sidebar_changed', 'standalone_agent_delete_target_changed', 'standalone_agent_row_not_visible',
  'preexisting_dialog', 'preexisting_context_menu', 'row_action_not_visible', 'delete_menu_not_bound_to_row',
  'delete_menu_not_found', 'delete_menu_not_visible', 'delete_dialog_not_confirmed', 'delete_confirm_not_visible',
  'delete_dialog_still_open', 'delete_control_unavailable', 'delete_verification_unavailable', 'delete_verification_failed'
]);

function parseConversationId(value) {
  const input = String(value || '').trim();
  if (input.startsWith('solo-session:')) {
    try {
      const sessionId = decodeURIComponent(input.slice('solo-session:'.length));
      return sessionId && sessionId.length <= 256
        && Array.from(sessionId).every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127)
        ? { sessionId }
        : null;
    } catch {
      return null;
    }
  }
  const match = /^solo:([A-Za-z0-9_-]+)$/.exec(input);
  if (!match) return null;
  if (/^\d+$/.test(match[1])) return { index: Number(match[1]) };
  try {
    const titleIncludes = Buffer.from(match[1], 'base64url').toString('utf8').trim();
    return titleIncludes ? { titleIncludes } : null;
  } catch {
    return null;
  }
}

function stableConversationTitle(value) {
  return String(value || '')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\d{1,2}月\d{1,2}日/g, ' ')
    .replace(/任务完成|任务中断|进行中|思考中|生成中|排队中|已完成/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function conversationId(chat) {
  if (typeof chat?.sessionId === 'string' && chat.sessionId.trim()) {
    return `solo-session:${encodeURIComponent(chat.sessionId.trim())}`;
  }
  const stableTitle = stableConversationTitle(chat?.title || chat?.text);
  return stableTitle
    ? `solo:${Buffer.from(stableTitle, 'utf8').toString('base64url')}`
    : `solo:${chat.index}`;
}

function auditSecurityAction(ctx, req, action, resource, params, status = 'success', error = null) {
  if (!ctx.auditLogger || typeof ctx.auditLogger.log !== 'function') return;
  ctx.auditLogger.log({ req, action, resource, params, status, error });
}

function normalizeCommand(value) {
  return String(value || '').trim();
}

async function currentInteractionContext(ctx) {
  if (typeof ctx.driver.getActiveSoloChat !== 'function') return {};
  const hasNativeBinding = Array.from(ctx.taskQueue?.values() || [])
    .some(task => typeof task.soloChat?.sessionId === 'string' && task.soloChat.sessionId.trim());
  const mode = typeof ctx.driver.detectMode === 'function' ? await ctx.driver.detectMode() : null;
  if ((mode?.mode && mode.mode !== 'solo') || (mode?.mode !== 'solo' && !hasNativeBinding)) return {};
  const active = await ctx.driver.getActiveSoloChat();
  return { activeSessionId: typeof active?.active?.sessionId === 'string' ? active.active.sessionId.trim() : null };
}

function taskInteractionContextMatches(ctx, taskId, context, dialog = null) {
  if (!taskId) return true;
  const task = ctx.taskQueue?.get(taskId);
  const boundSessionId = typeof task?.soloChat?.sessionId === 'string' ? task.soloChat.sessionId.trim() : '';
  if (boundSessionId && boundSessionId !== context.activeSessionId) return false;
  const storedCommand = normalizeCommand(task?.result?.command);
  return !dialog || !storedCommand || storedCommand === normalizeCommand(dialog.command);
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map(step => {
      if (typeof step === 'string') {
        return step.trim() ? { task: step.trim(), autoContinue: true, reviewRequired: false } : null;
      }
      const message = typeof step?.message === 'string' ? step.message.trim() : '';
      return message ? {
        task: message,
        autoContinue: true,
        reviewRequired: false,
        ...(step.completionChecks ? { completionChecks: step.completionChecks } : {})
      } : null;
    })
    .filter(Boolean);
}

async function handleSubmit(req, res, ctx) {
  const body = await parseBody(req);
  const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
  if (idempotencyKey.length > 256) {
    return ctx._json(req, res, {
      error: 'Idempotency-Key exceeds 256 characters',
      code: 'INVALID_IDEMPOTENCY_KEY'
    }, 400);
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return ctx._json(req, res, { error: 'message is required' }, 400);
  if (message.length > 100000) return ctx._json(req, res, { error: 'message exceeds 100000 characters' }, 400);
  if (isGenericQueueProbeTask(message)) {
    return ctx._json(req, res, {
      error: 'generic_queue_probe_task_rejected',
      message: 'The gateway already tracks queued work. Query the existing task instead.'
    }, 400);
  }

  let desiredMode = body.mode === 'solo' || body.mode === 'ide' ? body.mode : null;
  let desiredModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
  let projectPath = typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : null;
  let soloChat = parseConversationId(body.conversationId);
  if (body.conversationId && !soloChat) {
    return ctx._json(req, res, { error: 'valid conversationId is required' }, 400);
  }
  const followupTasks = normalizeSteps(body.steps);
  const reviewRequired = body.reviewRequired === true;
  const requestIntent = {
    task: message,
    ...(projectPath ? { projectPath } : {}),
    ...(desiredModel ? { desiredModel } : {}),
    ...(desiredMode ? { desiredMode } : {}),
    ...(soloChat ? { soloChat } : {}),
    newConversation: body.newConversation === true,
    followupTasks,
    ...(body.completionChecks ? { completionChecks: body.completionChecks } : {}),
    // Keep the original submission identity; reviewRequired already identifies
    // the user's review choice. Execution below must honor that choice.
    autoContinue: true,
    reviewRequired,
    autoApproveDialog: 'auto'
  };
  const idempotencyFingerprint = idempotencyKey
    ? ctx._fingerprintTaskRequest(requestIntent)
    : null;
  if (idempotencyKey) {
    const replay = ctx._resolveTaskIdempotency(idempotencyKey, requestIntent);
    if (replay) {
      return ctx._json(req, res, replay.data, replay.statusCode);
    }
  }

  await ctx._ensureConnection();
  if ((ctx.traeTarget?.workspaceKind === 'agent' || isKnownStandaloneAgentVersion(ctx.traeEnvironment?.appVersion)) &&
      (await ctx.driver.inspectWorkspaceBlockers()).loginVisible) {
    return ctx._json(req, res, {
      error: 'Sign in to TraeCN before submitting a task.',
      code: 'LOGIN_REQUIRED'
    }, 409);
  }
  if (projectPath) await ctx._ensureRequestedWorkspace(projectPath);
  if (!projectPath && ctx._selectedWorkspacePath && typeof ctx._assertProjectWorkspace === 'function') {
    try {
      await ctx._assertProjectWorkspace(ctx._selectedWorkspacePath);
      projectPath = ctx._selectedWorkspacePath;
    } catch {
      ctx._selectedWorkspacePath = null;
    }
  }
  if (!desiredMode && typeof ctx.driver.detectMode === 'function') {
    const detected = await ctx.driver.detectMode();
    desiredMode = detected?.mode === 'solo' || detected?.mode === 'ide' ? detected.mode : null;
  }
  if (!desiredModel && typeof ctx.driver.getCurrentModel === 'function') {
    const currentModel = await ctx.driver.getCurrentModel();
    desiredModel = typeof currentModel === 'string' && currentModel.trim() ? currentModel.trim() : null;
  }
  if (!soloChat && body.newConversation !== true && desiredMode === 'solo' && typeof ctx.driver.listSoloChats === 'function') {
    const listed = await ctx.driver.listSoloChats();
    const active = (listed.chats || []).find(chat => chat.active === true);
    if (active) {
      soloChat = parseConversationId(conversationId(active));
    }
  }

  const queuedBody = {
    task: message,
    ...(projectPath ? { projectPath } : {}),
    ...(desiredModel ? { desiredModel } : {}),
    ...(desiredMode ? { desiredMode } : {}),
    ...(soloChat ? { soloChat } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(idempotencyFingerprint ? { idempotencyFingerprint } : {}),
    newConversation: body.newConversation === true,
    followupTasks,
    ...(body.completionChecks ? { completionChecks: body.completionChecks } : {}),
    autoContinue: !reviewRequired,
    reviewRequired,
    autoApproveDialog: 'auto'
  };
  // Context discovery yields to other HTTP submissions. Recheck the original
  // intent immediately before synchronous acceptance so one key creates one
  // durable task even when several callers passed the early replay check.
  if (idempotencyKey) {
    const replay = ctx._resolveTaskIdempotency(idempotencyKey, requestIntent);
    if (replay) return ctx._json(req, res, replay.data, replay.statusCode);
  }
  const task = ctx._createQueuedTask(queuedBody, {
    queued: true,
    running: false,
    queueMessage: 'accepted for gateway-managed execution'
  });
  task.desiredModel = desiredModel;
  task.desiredMode = desiredMode;
  task.newConversation = queuedBody.newConversation;
  ctx._ensureBackgroundPolling();
  const response = { taskId: task.taskId, status: 'accepted' };
  const sent = ctx._json(req, res, response, 202);
  ctx._wakeBackgroundPolling?.();
  return sent;
}

async function handleListConversations(req, res, ctx) {
  await ctx._ensureConnection();
  const modeInfo = typeof ctx.driver.detectMode === 'function'
    ? await ctx.driver.detectMode()
    : { mode: 'unknown' };
  const mode = modeInfo.mode || 'unknown';
  if (mode !== 'solo' || typeof ctx.driver.listSoloChats !== 'function') {
    return ctx._json(req, res, { mode, conversations: [] });
  }
  const listed = await ctx.driver.listSoloChats();
  const conversations = (Array.isArray(listed.chats) ? listed.chats : []).map(chat => ({
    id: conversationId(chat),
    title: chat.title || '',
    active: chat.active === true
  }));
  return ctx._json(req, res, { mode: 'solo', conversations });
}

async function handleListModels(req, res, ctx) {
  await ctx._ensureConnection();
  return ctx._withUiActionLock(async () => {
    if (ctx._shutdownInProgress || !ctx.driver) {
      throw TraeCNAutomationError.cdpDisconnected(ctx._shutdownInProgress
        ? 'Gateway is shutting down'
        : 'TraeCN driver is unavailable');
    }
    if (typeof ctx.driver.listModels !== 'function') {
      return ctx._json(req, res, { error: 'model listing is not supported by the active TraeCN driver' }, 501);
    }
    if ((ctx.traeTarget?.workspaceKind === 'agent' || isKnownStandaloneAgentVersion(ctx.traeEnvironment?.appVersion)) &&
        (await ctx.driver.inspectWorkspaceBlockers()).loginVisible) {
      return ctx._json(req, res, {
        error: 'Sign in to TraeCN before reading available models.',
        code: 'LOGIN_REQUIRED'
      }, 409);
    }
    return ctx._json(req, res, await ctx.driver.listModels());
  });
}

async function handleManageConversation(req, res, ctx) {
  const body = await parseBody(req);
  const action = String(body.action || '');
  if (!['create', 'select', 'delete'].includes(action)) {
    return ctx._json(req, res, { error: 'action must be create, select, or delete' }, 400);
  }
  if (action === 'delete' && body.acknowledgePermanentDeletion !== true) {
    return ctx._json(req, res, {
      error: 'permanent_deletion_acknowledgement_required',
      message: 'Deleting a TraeCN conversation is permanent and cannot be recovered by the gateway.'
    }, 400);
  }
  if (action === 'delete' && (typeof body.expectedTitle !== 'string' || !body.expectedTitle.trim())) {
    return ctx._json(req, res, { error: 'expectedTitle is required for permanent deletion' }, 400);
  }
  await ctx._ensureConnection();
  const standaloneAgent = ctx.traeTarget?.workspaceKind === 'agent';
  const expectedTitle = action === 'delete'
    ? (standaloneAgent ? body.expectedTitle : stableConversationTitle(body.expectedTitle))
    : '';
  if (action === 'delete' && !expectedTitle) {
    return ctx._json(req, res, { error: 'expectedTitle is required for permanent deletion' }, 400);
  }
  if (action === 'delete' && standaloneAgent && ctx.traeEnvironment?.appVersion !== '3.4.15') {
    return ctx._json(req, res, {
      error: 'Standalone Agent conversation deletion is not supported. Delete it in TraeCN if needed.',
      code: 'STANDALONE_AGENT_DELETE_UNSUPPORTED'
    }, 501);
  }
  return ctx._withUiActionLock(async () => {
    if (action === 'create') {
      const before = typeof ctx.driver.listSoloChats === 'function' ? await ctx.driver.listSoloChats() : null;
      const existingSessions = new Set((before?.chats || []).map(chat => chat.sessionId).filter(Boolean));
      const success = await ctx.driver.newChat();
      const after = success !== false && typeof ctx.driver.listSoloChats === 'function'
        ? await ctx.driver.listSoloChats()
        : null;
      const active = (after?.chats || []).find(chat => chat.active === true && chat.sessionId
        && !existingSessions.has(chat.sessionId));
      return ctx._json(req, res, {
        action,
        success: success !== false,
        fresh: success !== false,
        conversationId: active ? conversationId(active) : null,
        creationDeferred: success !== false && !active
      });
    }
    const target = parseConversationId(body.conversationId);
    if (!target) return ctx._json(req, res, { error: 'valid conversationId is required' }, 400);
    if (action === 'select') {
      const result = await ctx.driver.switchSoloChat(target);
      return ctx._json(req, res, { action, conversationId: body.conversationId, ...result }, result.success === false ? 404 : 200);
    }
    if (standaloneAgent && !target.sessionId) {
      return ctx._json(req, res, { error: 'A native conversationId is required for standalone Agent deletion.' }, 400);
    }
    const listed = await ctx.driver.listSoloChats(standaloneAgent ? { standaloneAgent: true } : undefined);
    if (standaloneAgent && listed?.mode !== 'solo') {
      return ctx._json(req, res, { error: 'Standalone Agent conversation list is unavailable.' }, 409);
    }
    const chat = (listed.chats || []).find(candidate => (
      target.sessionId
        ? candidate.sessionId === target.sessionId
        : target.index !== undefined
        ? candidate.index === target.index
        : stableConversationTitle(candidate.title || candidate.text) === target.titleIncludes
    ));
    if (!chat) return ctx._json(req, res, { error: 'conversation not found' }, 404);
    const actualTitle = standaloneAgent ? chat.title : stableConversationTitle(chat.title || chat.text);
    if (actualTitle !== expectedTitle) {
      auditSecurityAction(ctx, req, 'conversation.delete', String(body.conversationId), {
        expectedTitle,
        actualTitle
      }, 'failure', 'conversation_title_mismatch');
      return ctx._json(req, res, {
        error: 'conversation_title_mismatch',
        expectedTitle,
        actualTitle
      }, 409);
    }
    if (chat.active === true) {
      auditSecurityAction(ctx, req, 'conversation.delete', String(body.conversationId), {
        title: actualTitle
      }, 'failure', 'active_conversation_delete_forbidden');
      return ctx._json(req, res, {
        error: 'active_conversation_delete_forbidden',
        message: 'Select a different conversation before permanently deleting this one.'
      }, 409);
    }
    const result = await ctx.driver.deleteSoloChats({
      ...(standaloneAgent ? { standaloneAgent: true } : {}),
      candidates: [{
        index: chat.index,
        ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
        title: chat.title || ''
      }]
    });
    const deleted = result.deleted || 0;
    const attemptReason = result.attempts?.[0]?.reason;
    const failure = standaloneAgent && SAFE_STANDALONE_DELETE_FAILURES.has(attemptReason)
      ? attemptReason
      : 'delete_failed';
    auditSecurityAction(ctx, req, 'conversation.delete', String(body.conversationId), {
      title: actualTitle,
      deleted,
      recoverable: false
    }, deleted > 0 ? 'success' : 'failure', deleted > 0 ? null : failure);
    return ctx._json(req, res, {
      action,
      conversationId: body.conversationId,
      deleted,
      recoverable: false,
      ...(standaloneAgent && deleted === 0 ? { error: 'delete_failed', code: failure } : {})
    }, deleted > 0 ? 200 : 409);
  });
}

async function resolveInteractionBody(body, req, res, ctx, options = {}) {
  const pendingTask = options.taskId
    ? ctx.taskQueue?.get(options.taskId)
    : Array.from(ctx.taskQueue?.values() || []).find(task => (task.statePersistencePending || task.cancelPersistencePending) && task.status === 'approval_required');
  if (pendingTask?.statePersistencePending || pendingTask?.cancelPersistencePending) {
    return ctx._json(req, res, {
      error: 'task_state_persistence_pending',
      message: 'The task state is awaiting storage confirmation; retry after storage recovers.'
    }, 409);
  }
  const action = String(body.action || '');
  if (!['approve', 'deny', 'answer', 'dismiss'].includes(action)) {
    return ctx._json(req, res, { error: 'action must be approve, deny, answer, or dismiss' }, 400);
  }
  await ctx._ensureConnection();
  let result;
  if (action === 'answer') {
    if (!body.answer || typeof ctx.driver.answerQuestionDialog !== 'function') {
      return ctx._json(req, res, { error: 'answer is required for question interactions' }, 400);
    }
    const interactionContext = await currentInteractionContext(ctx);
    if (!taskInteractionContextMatches(ctx, options.taskId, interactionContext)) {
      return ctx._json(req, res, { error: 'task_interaction_conflict', message: 'The active conversation changed; refresh the task before deciding.' }, 409);
    }
    result = await ctx.driver.answerQuestionDialog(body.answer);
    if (result.success === true && typeof ctx._resumeApprovalRequiredTasksAfterDialogAnswer === 'function') {
      result.resumedTaskIds = ctx._resumeApprovalRequiredTasksAfterDialogAnswer(
        body.answer,
        result,
        options.taskId || null,
        interactionContext
      );
    }
  } else {
    let dialog = options.dialog || null;
    if (!dialog && typeof ctx.driver.checkForApprovalDialog === 'function') {
      dialog = await ctx.driver.checkForApprovalDialog();
    }
    if (action === 'approve') {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const expectedCommand = normalizeCommand(body.expectedCommand);
      if (body.acknowledgeRisk !== true || !expectedCommand || !reason || reason.length > 500) {
        return ctx._json(req, res, {
          error: 'approval_authorization_context_required',
          message: 'Approval requires expectedCommand, acknowledgeRisk=true, and an audit reason of 1-500 characters.'
        }, 400);
      }
      if (!dialog?.needsApproval || !dialog.isCommandExec) {
        return ctx._json(req, res, {
          error: 'exceptional_command_approval_not_found',
          message: 'No command approval is currently pending.'
        }, 409);
      }
      const actualCommand = normalizeCommand(dialog.command);
      if (!actualCommand || actualCommand !== expectedCommand) {
        auditSecurityAction(ctx, req, 'interaction.approval_decision', 'trae:current-dialog', {
          decision: action,
          risk: dialog.commandRisk || 'unknown',
          reasonCodes: dialog.riskReasons || []
        }, 'failure', 'approval_command_mismatch');
        return ctx._json(req, res, {
          error: 'approval_command_mismatch',
          message: 'The visible command changed; inspect the current interaction before deciding.'
        }, 409);
      }
    }
    const interactionContext = await currentInteractionContext(ctx);
    if (!taskInteractionContextMatches(ctx, options.taskId, interactionContext, dialog)) {
      return ctx._json(req, res, { error: 'task_interaction_conflict', message: 'The visible interaction or active conversation changed; refresh the task before deciding.' }, 409);
    }
    result = action === 'approve'
      ? await ctx.driver.approveDialog(action, { expectedCommand: body.expectedCommand })
      : await ctx.driver.approveDialog(action);
    if (result.success === true && typeof ctx._resumeApprovalRequiredTasksAfterInteraction === 'function') {
      result.resumedTaskIds = ctx._resumeApprovalRequiredTasksAfterInteraction(
        action,
        dialog,
        result,
        options.taskId || null,
        interactionContext
      );
    }
    auditSecurityAction(ctx, req, 'interaction.approval_decision', options.taskId ? `trae:task:${options.taskId}` : 'trae:current-dialog', {
      decision: action,
      reason: typeof body.reason === 'string' ? body.reason.trim() : null,
      risk: dialog?.commandRisk || null,
      reasonCodes: dialog?.riskReasons || []
    }, result.success === false ? 'failure' : 'success', result.error || null);
  }
  return ctx._json(req, res, result, result.success === false ? 409 : 200);
}

async function handleResolveInteraction(req, res, ctx) {
  const body = await parseBody(req);
  const resolve = () => resolveInteractionBody(body, req, res, ctx);
  return typeof ctx._withUiActionLock === 'function'
    ? ctx._withUiActionLock(resolve)
    : resolve();
}

module.exports = {
  ROUTES,
  parseConversationId,
  stableConversationTitle,
  conversationId,
  normalizeSteps,
  resolveInteractionBody,
  handleSubmit,
  handleListModels,
  handleListConversations,
  handleManageConversation,
  handleResolveInteraction
};
