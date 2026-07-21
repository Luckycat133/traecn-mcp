'use strict';

const { parseBody } = require('../request-gate');
const { buildConfirmationPlan } = require('../../shared/operation-confirmation');
const { listCommands } = require('../../../integrations/openclaw-traecn-plugin/lib/command-set');
const { rejectBadRequest } = require('./helpers');

/**
 * preflight handlers.
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
      "path": "/api/confirm/plan",
      "handler": "_handleConfirmPlan",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    },
    {
      "method": "POST",
      "path": "/api/preflight",
      "handler": "_handlePreflight",
      "requiresAuth": true,
      "requiresRateLimit": true,
      "requiresBody": true
    }
  ];

async function handleConfirmPlan(req, res, ctx) {
  const body = await parseBody(req);
  if (!body.command || typeof body.command !== 'string') {
    return rejectBadRequest(req, res, ctx, 'command is required');
  }
  ctx._json(req, res, buildConfirmationPlan(body));
}
async function handlePreflight(req, res, ctx) {
  const body = await parseBody(req);
  if (body.command !== undefined && typeof body.command !== 'string') {
    return ctx._json(req, res, { error: 'command must be a string' }, 400);
  }

  let status = await ctx._statusSnapshot();
  const connectionProbe = await ctx._probe('connection', async () => {
    await ctx._ensureConnection();
    return true;
  });

  const connected = connectionProbe.ok;
  if (connected) {
    status = await ctx._statusSnapshot();
  }
  const readinessProbe = connected
    ? await ctx._probe('readiness', () => ctx.driver.checkReadiness())
    : { name: 'readiness', ok: false, error: connectionProbe.error, code: connectionProbe.code };
  const queueProbe = connected
    ? await ctx._probe('queue', () => ctx.driver.checkQueueStatus())
    : { name: 'queue', ok: false, error: connectionProbe.error, code: connectionProbe.code };
  const dialogProbe = connected
    ? await ctx._probe('dialog', () => ctx.driver.checkForApprovalDialog())
    : { name: 'dialog', ok: false, error: connectionProbe.error, code: connectionProbe.code };

  const readiness = readinessProbe.ok ? ctx._compactReadiness(readinessProbe.value) : null;
  const queue = queueProbe.ok ? ctx._compactQueue(ctx._applyRecentQueueSnapshot(queueProbe.value)) : null;
  const dialog = dialogProbe.ok ? ctx._compactDialog({
    hasDialog: dialogProbe.value.needsApproval,
    dialogType: dialogProbe.value.dialogType,
    question: dialogProbe.value.question,
    buttons: dialogProbe.value.buttons,
    canAutoApprove: dialogProbe.value.canAutoApprove
  }) : null;
  const commandPlan = body.command
    ? buildConfirmationPlan({ command: body.command, params: body.params || {}, forceConfirm: body.forceConfirm === true })
    : null;
  const queueAllowsSubmit = !queue?.queued || queue?.canSubmit === true;
  const canDelegate = connected && readiness?.ready === true && queueAllowsSubmit && !queue?.running && !dialog?.hasDialog;
  const nextAction = ctx._preflightNextAction({ connected, surface: status.surface, readiness, queue, dialog, status });
  const commands = listCommands();

  ctx._json(req, res, {
    ok: connected,
    service: status.service,
    version: status.version,
    mockBridge: status.mockBridge,
    connected,
    cdpReachable: status.cdpReachable,
    surface: status.surface,
    ready: readiness?.ready === true,
    canDelegate,
    nextAction,
    tokenHint: commandPlan
      ? 'Use this single preflight result before executing the command; pass confirmationId only when commandPlan.requiresConfirmation is true.'
      : 'Use preflight before delegation to avoid separate status/readiness/queue/dialog calls.',
    status,
    readiness: readiness || { ok: false, error: readinessProbe.error, code: readinessProbe.code },
    queue: queue || { ok: false, error: queueProbe.error, code: queueProbe.code },
    dialog: dialog || { ok: false, error: dialogProbe.error, code: dialogProbe.code },
    localQueue: ctx._queueRuntimeSummary(),
    commandPlan,
    capabilities: {
      commandCount: commands.length,
      preferredFlow: ['preflight', 'delegate_async', 'task_status'],
      fullCatalog: '/api/capabilities',
      fullSchema: '/openapi.json'
    }
  });
}

module.exports = { ROUTES, handleConfirmPlan, handlePreflight };
