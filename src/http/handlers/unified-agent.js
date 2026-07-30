'use strict';

const { parseBody } = require('../request-gate');
const { isGenericQueueProbeTask } = require('../../shared/utils');

const ROUTES = [
  { method: 'POST', path: '/api/tasks/submit', handler: '_handleUnifiedSubmit', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'GET', path: '/api/conversations', handler: '_handleListConversations', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/conversations/manage', handler: '_handleManageConversation', requiresAuth: true, requiresRateLimit: true, requiresBody: true },
  { method: 'POST', path: '/api/interactions/resolve', handler: '_handleResolveInteraction', requiresAuth: true, requiresRateLimit: true, requiresBody: true }
];

function parseConversationId(value) {
  const match = /^solo:([A-Za-z0-9_-]+)$/.exec(String(value || '').trim());
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
    .replace(/任务完成|进行中|思考中|生成中|排队中|已完成/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function conversationId(chat) {
  const stableTitle = stableConversationTitle(chat?.title || chat?.text);
  return stableTitle
    ? `solo:${Buffer.from(stableTitle, 'utf8').toString('base64url')}`
    : `solo:${chat.index}`;
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
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return ctx._json(req, res, { error: 'message is required' }, 400);
  if (message.length > 100000) return ctx._json(req, res, { error: 'message exceeds 100000 characters' }, 400);
  if (isGenericQueueProbeTask(message)) {
    return ctx._json(req, res, {
      error: 'generic_queue_probe_task_rejected',
      message: 'The gateway already tracks queued work. Query the existing task instead.'
    }, 400);
  }

  const desiredMode = body.mode === 'solo' || body.mode === 'ide' ? body.mode : null;
  const desiredModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
  const projectPath = typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : null;
  const soloChat = parseConversationId(body.conversationId);

  await ctx._ensureConnection();
  if (projectPath) await ctx._ensureRequestedWorkspace(projectPath);

  const queuedBody = {
    task: message,
    ...(projectPath ? { projectPath } : {}),
    ...(desiredModel ? { desiredModel } : {}),
    ...(desiredMode ? { desiredMode } : {}),
    ...(soloChat ? { soloChat } : {}),
    newConversation: body.newConversation === true || !soloChat,
    followupTasks: normalizeSteps(body.steps),
    ...(body.completionChecks ? { completionChecks: body.completionChecks } : {}),
    autoContinue: true,
    reviewRequired: false,
    autoApproveDialog: 'auto'
  };
  const task = ctx._createQueuedTask(queuedBody, {
    queued: true,
    running: false,
    queueMessage: 'accepted for gateway-managed execution'
  });
  task.desiredModel = desiredModel;
  task.desiredMode = desiredMode;
  task.newConversation = queuedBody.newConversation;
  ctx._syncTaskHistoryMirror(task);
  ctx._persistActiveQueue();
  ctx._ensureBackgroundPolling();
  return ctx._json(req, res, { taskId: task.taskId, status: 'accepted' }, 202);
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

async function handleManageConversation(req, res, ctx) {
  const body = await parseBody(req);
  const action = String(body.action || '');
  if (!['create', 'select', 'delete'].includes(action)) {
    return ctx._json(req, res, { error: 'action must be create, select, or delete' }, 400);
  }
  await ctx._ensureConnection();
  return ctx._withUiActionLock(async () => {
    if (action === 'create') {
      const success = await ctx.driver.newChat();
      return ctx._json(req, res, { action, success: success !== false });
    }
    const target = parseConversationId(body.conversationId);
    if (!target) return ctx._json(req, res, { error: 'valid conversationId is required' }, 400);
    if (action === 'select') {
      const result = await ctx.driver.switchSoloChat(target);
      return ctx._json(req, res, { action, conversationId: body.conversationId, ...result }, result.success === false ? 404 : 200);
    }
    const listed = await ctx.driver.listSoloChats();
    const chat = (listed.chats || []).find(candidate => candidate.index === target.index);
    if (!chat) return ctx._json(req, res, { error: 'conversation not found' }, 404);
    const result = await ctx.driver.deleteSoloChats({ candidates: [{ index: chat.index, title: chat.title || '' }] });
    return ctx._json(req, res, { action, conversationId: body.conversationId, deleted: result.deleted || 0 });
  });
}

async function handleResolveInteraction(req, res, ctx) {
  const body = await parseBody(req);
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
    result = await ctx.driver.answerQuestionDialog(body.answer);
  } else {
    result = await ctx.driver.approveDialog(action);
  }
  return ctx._json(req, res, result, result.success === false ? 409 : 200);
}

module.exports = {
  ROUTES,
  parseConversationId,
  stableConversationTitle,
  conversationId,
  normalizeSteps,
  handleSubmit,
  handleListConversations,
  handleManageConversation,
  handleResolveInteraction
};
