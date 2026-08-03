'use strict';

const { URL } = require('url');
const { parseBody } = require('../request-gate');

const ROUTES = [
  { method: 'GET', path: '/api/task-events', handler: '_handleListTaskEvents', requiresAuth: true, requiresRateLimit: true, requiresBody: false },
  { method: 'POST', path: '/api/task-events/ack', handler: '_handleAckTaskEvent', requiresAuth: true, requiresRateLimit: true, requiresBody: true }
];

async function handleListTaskEvents(req, res, ctx) {
  const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
  const clientId = parsedUrl.searchParams.get('clientId') || 'default';
  const after = parsedUrl.searchParams.get('after') || null;
  const limit = Number(parsedUrl.searchParams.get('limit')) || 20;
  const rawWaitMs = Number(parsedUrl.searchParams.get('waitMs'));
  const waitMs = Number.isFinite(rawWaitMs) ? Math.max(0, Math.min(rawWaitMs, 30000)) : 0;
  const options = { clientId, after, limit };
  const result = waitMs > 0
    ? await ctx.taskEventStore.wait({ ...options, timeoutMs: waitMs })
    : ctx.taskEventStore.list(options);
  ctx._json(req, res, result);
}

async function handleAckTaskEvent(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.clientId || !body.eventId) {
    ctx._json(req, res, { error: 'clientId and eventId are required' }, 400);
    return;
  }
  const result = ctx.taskEventStore.ack(body.clientId, body.eventId);
  const status = result.acknowledged
    ? 200
    : (result.error === 'TASK_EVENT_STORE_UNAVAILABLE' ? 503 : 404);
  ctx._json(req, res, result, status);
}

module.exports = {
  ROUTES,
  handleListTaskEvents,
  handleAckTaskEvent
};
