'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const { loadEnv } = require('../src/config/env');
const { resolveCDPEndpoint } = require('../src/cdp/discovery');
const { startGateway } = require('../src/http/gateway');
const { MCP_TOOLS } = require('../mcp-server');
const { toolDefinitions: openClawTools } = require('../integrations/openclaw-traecn-plugin');
const { listCommands } = require('../src/client/command-set');
const { readArg, resolveGatewayToken } = require('./lib/cli-config');

loadEnv(path.resolve(__dirname, '..', '.env'));

const strict = process.argv.includes('--strict');
const requireReady = process.argv.includes('--require-ready');
const requireVerifiedAdapter = process.argv.includes('--require-verified-adapter');
const allowDelegate = process.argv.includes('--delegate');
const cleanupQueueProbes = process.argv.includes('--cleanup-queue-probes') || process.env.TRAECN_LIVE_UAT_CLEANUP_QUEUE_PROBES === '1';
const exerciseBackgroundWorkflow = process.argv.includes('--exercise-background-workflow');
const autoReviewDecision = readArg('--auto-review-decision') || 'approve';
const delegateTask = readArg('--delegate-task') || '请用一句话回复 TRAECNclaw live UAT ready';
const delegateTimeoutMs = Number(readArg('--delegate-timeout-ms') || 120000);
const taskPollIntervalMs = Number(readArg('--task-poll-interval-ms') || 5000);
const taskPollTimeoutMs = Number(readArg('--task-poll-timeout-ms') || 240000);
const followupTask = readArg('--followup-task') || '请只回复 FOLLOWUP_REVIEW_OK';

function skip(reason) {
  console.log('[live-uat] ' + JSON.stringify({ status: 'SKIP', reason, strict }, null, 2));
  if (strict) process.exitCode = 1;
}

function request(port, method, route, body = null, token = '', timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Accept: 'application/json',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      agent: false,
      headers,
      timeout: timeoutMs
    }, res => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        let data = responseBody;
        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          // Keep raw text for non-JSON responses.
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${method} ${route} timed out`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function summarizeReadiness(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ready: false, reason: 'readiness response was not an object' };
  }
  if (data.ready === true) return { ready: true };

  const missing = new Set();
  for (const [key, value] of Object.entries(data.checks || {})) {
    if (value === false || value === null || value === undefined) missing.add(key);
  }
  for (const key of ['composer', 'sendButton', 'responseRegion']) {
    if (Object.hasOwn(data, key) && !data[key]) missing.add(key);
  }

  return {
    ready: false,
    reason: data.reason || data.error || data.blocker || (missing.size ? `missing UI checks: ${Array.from(missing).join(', ')}` : 'Trae CN UI is not ready for automation'),
    blocker: data.blocker || null,
    missing: Array.from(missing),
    currentMode: data.currentMode || data.mode?.mode || null,
    currentModel: data.currentModel || null
  };
}

function buildDiagnostics(endpoint, statusData, readinessData) {
  const readiness = summarizeReadiness(readinessData);
  const surface = statusData?.surface || null;
  return {
    cdp: {
      host: endpoint.host,
      port: endpoint.port,
      browser: endpoint.version.Browser || null,
      userAgent: endpoint.version['User-Agent'] || null
    },
    gateway: {
      connected: statusData?.status || 'unknown',
      mockBridge: statusData?.mockBridge === true,
      traeAdapter: statusData?.traeAdapter || null
    },
    surface,
    readiness,
    nextSteps: readiness.ready ? [] : [
      surface?.kind === 'setup'
        ? 'Finish the current Trae CN setup or login flow until the main workspace appears.'
        : 'Open Trae CN in the debug-enabled instance and complete login/onboarding.',
      'Open or focus a chat/project window with the message composer visible.',
      'Run npm run inspect:verify if readiness stays false after the UI is visible.',
      'Use node scripts/live-uat.js --require-ready for a strict readiness gate, add --cleanup-queue-probes to remove accidental queue-probe chats, and add --delegate only when sending a real prompt is acceptable.'
    ]
  };
}

function assertReady(readinessData, diagnostics, gateName) {
  if (readinessData && readinessData.ready === true) return;
  const err = new Error(`${gateName} requires Trae CN UI readiness; ${diagnostics.readiness.reason}`);
  err.diagnostics = diagnostics;
  throw err;
}

async function assertQueueProbeRejected(port, token, route, body, name) {
  const response = await request(port, 'POST', route, body, token);
  assert.strictEqual(response.status, 400, `${name} must reject queue-probe prompts`);
  assert.strictEqual(response.data.error, 'generic_queue_probe_task_rejected', `${name} should return generic_queue_probe_task_rejected`);
  return response;
}

async function assertNoForeignQueueProbeChats(port, token, cleanupDryRun, checks) {
  const matched = cleanupDryRun.data.matched || 0;
  if (matched === 0) {
    checks.push({ name: 'cleanup-dry-run', ok: true, matched: 0 });
    return;
  }

  if (!cleanupQueueProbes) {
    checks.push({ name: 'cleanup-dry-run', ok: false, matched });
    if (strict) {
      throw new Error(`Found ${matched} accidental queue-probe Solo chat(s). Re-run with --cleanup-queue-probes to stop/delete them, or run: node scripts/traecn-cli.js cleanup-queue --execute --json`);
    }
    return;
  }

  const cleanupExecute = await request(port, 'POST', '/api/solo/chats/cleanup-foreign-queue', {
    execute: true,
    maxPasses: 10
  }, token);
  assert.strictEqual(cleanupExecute.status, 200, 'cleanup execute should return 200 when queue-probe chats are matched');
  assert.strictEqual(cleanupExecute.data.support, 'delete_supported', 'cleanup execute should advertise delete support');
  checks.push({
    name: 'cleanup-execute',
    ok: true,
    matched,
    stopped: cleanupExecute.data.stopped || 0,
    deleted: cleanupExecute.data.deleted || 0,
    remainingMatched: cleanupExecute.data.remainingMatched || 0,
    passes: cleanupExecute.data.passes || 1
  });

  const cleanupVerify = await request(port, 'POST', '/api/solo/chats/cleanup-foreign-queue', {
    dryRun: true
  }, token);
  assert.strictEqual(cleanupVerify.status, 200, 'cleanup verify dry-run should return 200');
  assert.strictEqual(cleanupVerify.data.matched || 0, 0, 'cleanup verify must find no queue-probe chats after execute');
  checks.push({ name: 'cleanup-dry-run', ok: true, matched: 0, afterExecute: true });
}

async function waitForTaskTerminalState(port, taskId, token, timeoutMs) {
  const startedAt = Date.now();
  let lastSnapshot = null;
  while (Date.now() - startedAt < timeoutMs) {
    const status = await request(port, 'GET', `/api/task/${encodeURIComponent(taskId)}`, null, token);
    assert.strictEqual(status.status, 200, 'task status endpoint should return 200 during workflow polling');
    lastSnapshot = status.data;
    if (['awaiting_review', 'done', 'error', 'queue_timeout', 'cancelled', 'review_rejected', 'approval_required'].includes(status.data.status)) {
      return lastSnapshot;
    }
    await new Promise(resolve => setTimeout(resolve, taskPollIntervalMs));
  }
  const err = new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
  err.lastSnapshot = lastSnapshot;
  throw err;
}

async function main() {
  if (process.env.TRAECN_ENABLE_MOCK_BRIDGE === '1') {
    return skip('TRAECN_ENABLE_MOCK_BRIDGE=1; live UAT requires the real Trae CN bridge.');
  }

  let endpoint;
  try {
    endpoint = await resolveCDPEndpoint();
  } catch (err) {
    return skip(`No reachable Trae CN CDP endpoint: ${err.message}`);
  }

  if (!endpoint.isTraeCN) {
    return skip(`Reachable CDP endpoint does not look like Trae CN: ${JSON.stringify(endpoint.version)}`);
  }

  const token = resolveGatewayToken();
  let server;
  const checks = [];
  let lastStatusData = null;
  let lastReadinessData = null;
  let gateway = null;
  try {
    const started = await startGateway({ host: '127.0.0.1', port: 0 });
    server = started.server;
    gateway = started.gateway;
    const port = server.address().port;

    const status = await request(port, 'GET', '/api/status?allowAutoStart=false', null, token);
    assert.strictEqual(status.status, 200, 'status endpoint should return 200');
    assert.notStrictEqual(status.data.mockBridge, true, 'live UAT must not use mock bridge');
    lastStatusData = status.data;
    checks.push({ name: 'status', ok: true, connected: status.data.status });

    const readiness = await request(port, 'GET', '/api/readiness', null, token);
    assert.strictEqual(readiness.status, 200, 'readiness endpoint should return 200');
    lastReadinessData = readiness.data;
    const readinessSummary = summarizeReadiness(readiness.data);
    checks.push({ name: 'readiness', ok: true, ready: readinessSummary.ready, reason: readinessSummary.ready ? undefined : readinessSummary.reason });

    const connectedStatus = await request(port, 'GET', '/api/status?allowAutoStart=false', null, token);
    assert.strictEqual(connectedStatus.status, 200, 'post-readiness status endpoint should return 200');
    lastStatusData = connectedStatus.data;
    checks.push({ name: 'post-readiness-status', ok: true, connected: connectedStatus.data.status });
    assert.ok(connectedStatus.data.traeAdapter, 'connected status must include a Trae adapter handshake');
    checks.push({
      name: 'trae-adapter',
      ok: connectedStatus.data.traeAdapter.verified === true,
      adapter: connectedStatus.data.traeAdapter.adapter,
      traeVersion: connectedStatus.data.traeAdapter.traeVersion,
      compatibility: connectedStatus.data.traeAdapter.compatibility
    });
    if (requireVerifiedAdapter) {
      assert.strictEqual(
        connectedStatus.data.traeAdapter.verified,
        true,
        `--require-verified-adapter rejected ${connectedStatus.data.traeAdapter.adapter}`
      );
    }

    const diagnostics = buildDiagnostics(endpoint, lastStatusData, lastReadinessData);
    if (requireReady || allowDelegate || exerciseBackgroundWorkflow) {
      const gateName = requireReady ? '--require-ready' : allowDelegate ? '--delegate' : '--exercise-background-workflow';
      assertReady(readiness.data, diagnostics, gateName);
      if (requireReady) checks.push({ name: 'require-ready', ok: true });
    }

    const queue = await request(port, 'GET', '/api/queue-status', null, token);
    assert.strictEqual(queue.status, 200, 'queue-status endpoint should return 200');
    checks.push({ name: 'queue-status', ok: true, queued: queue.data.queued === true });

    const dialog = await request(port, 'GET', '/api/dialog/status', null, token);
    assert.strictEqual(dialog.status, 200, 'dialog-status endpoint should return 200');
    checks.push({ name: 'dialog-status', ok: true, hasDialog: dialog.data.hasDialog === true });

    const preflight = await request(port, 'POST', '/api/preflight', {
      command: 'delegate_async',
      params: { task: 'live UAT dry preflight' }
    }, token);
    assert.strictEqual(preflight.status, 200, 'preflight endpoint should return 200');
    assert.strictEqual(preflight.data.commandPlan?.command, 'delegate_async', 'preflight must include optional command plan');
    assert.ok(preflight.data.nextAction, 'preflight must include a next action');
    checks.push({ name: 'preflight', ok: true, ready: preflight.data.ready === true, nextAction: preflight.data.nextAction });

    const capabilities = await request(port, 'GET', '/api/capabilities');
    assert.strictEqual(capabilities.status, 200, 'capabilities endpoint should return 200');
    assert.ok(capabilities.data.commands?.some(command => command.command === 'delegate_async'), 'capabilities must include async delegation command');
    assert.ok(capabilities.data.commands?.some(command => command.command === 'cleanup_foreign_solo_queue'), 'capabilities must include cleanup command');
    assert.strictEqual(capabilities.data.coverage?.queueManagement, true, 'capabilities must advertise queue management');
    const asyncDelegate = capabilities.data.http?.find(operation => operation.path === '/api/delegate-async' && operation.method === 'POST');
    const soloSubmit = capabilities.data.http?.find(operation => operation.path === '/api/solo/chats/submit' && operation.method === 'POST');
    assert.ok(asyncDelegate?.accepts?.includes('sessionId'), 'delegate_async capabilities must expose sessionId');
    assert.ok(asyncDelegate?.accepts?.includes('soloChatTitleIncludes'), 'delegate_async capabilities must expose Solo targeting');
    assert.ok(asyncDelegate?.accepts?.includes('forceBackground'), 'delegate_async capabilities must expose forceBackground');
    assert.ok(soloSubmit?.accepts?.includes('queueMaxWaitMs'), 'Solo submit capabilities must expose queueMaxWaitMs');
    checks.push({ name: 'capabilities', ok: true, commands: capabilities.data.commands.length });

    const layeredProbe = [
      '## Role and Objective',
      'You are TraeCN operating inside a controlled workflow.',
      '',
      '## User Command Payload',
      'wait for Trae queue',
      'Raw params: {"task":"wait for Trae queue"}'
    ].join('\n');
    await assertQueueProbeRejected(port, token, '/api/delegate', {
      task: layeredProbe
    }, 'delegate layered queue probe');
    await assertQueueProbeRejected(port, token, '/api/delegate-async', {
      task: layeredProbe
    }, 'delegate_async layered queue probe');
    await assertQueueProbeRejected(port, token, '/api/solo/chats/submit', {
      task: layeredProbe
    }, 'solo submit layered queue probe');
    await assertQueueProbeRejected(port, token, '/api/delegate', {
      task: 'Wait for Trae Queue 进行中 17:34'
    }, 'delegate status-title queue probe');
    checks.push({ name: 'queue-probe-guard', ok: true, variants: ['layered-payload', 'status-title'] });

    const confirmationPlan = await request(port, 'POST', '/api/confirm/plan', {
      command: 'approve_dialog',
      params: { action: 'trust' }
    }, token);
    assert.strictEqual(confirmationPlan.status, 200, 'confirmation plan endpoint should return 200');
    assert.strictEqual(confirmationPlan.data.risk, 'high', 'approve_dialog must be high risk');
    assert.strictEqual(confirmationPlan.data.requiresConfirmation, true, 'approve_dialog must require confirmation');
    checks.push({ name: 'confirmation-plan', ok: true, risk: confirmationPlan.data.risk });

    const cleanupPlan = await request(port, 'POST', '/api/confirm/plan', {
      command: 'cleanup_foreign_solo_queue',
      params: { execute: true }
    }, token);
    assert.strictEqual(cleanupPlan.status, 200, 'cleanup confirmation plan endpoint should return 200');
    assert.strictEqual(cleanupPlan.data.risk, 'high', 'cleanup_foreign_solo_queue must be high risk');
    assert.strictEqual(cleanupPlan.data.requiresConfirmation, true, 'cleanup_foreign_solo_queue must require confirmation');
    checks.push({ name: 'cleanup-confirmation-plan', ok: true, risk: cleanupPlan.data.risk });

    const confirmationGate = await request(port, 'POST', '/api/settings/set', {
      label: 'TRAECNclaw live UAT dry gate',
      value: true,
      requireConfirmation: true
    }, token);
    assert.strictEqual(confirmationGate.status, 409, 'confirmation gate should block high-risk settings writes without confirmationId');
    assert.strictEqual(confirmationGate.data.code, 'OPERATION_CONFIRMATION_REQUIRED');
    checks.push({ name: 'confirmation-gate', ok: true });

    const openapi = await request(port, 'GET', '/openapi.json');
    assert.strictEqual(openapi.status, 200, 'openapi endpoint should return 200');
    assert.ok(openapi.data.paths && openapi.data.paths['/api/delegate'], 'OpenAPI must include delegate route');
    assert.ok(openapi.data.paths['/api/solo/chats/cleanup-foreign-queue'], 'OpenAPI must include Solo queue cleanup route');
    assert.ok(openapi.data.paths['/api/solo/chats/submit']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.queueMaxWaitMs, 'OpenAPI Solo submit must expose queueMaxWaitMs');
    checks.push({ name: 'openapi', ok: true, paths: Object.keys(openapi.data.paths).length });

    assert.ok(listCommands().some(command => command.command === 'cleanup_foreign_solo_queue'), 'command set must include cleanup_foreign_solo_queue');
    assert.ok(MCP_TOOLS.some(tool => tool.name === 'traecn_send_message'), 'MCP tools must include traecn_send_message');
    assert.ok(openClawTools.some(tool => tool.name === 'traecn_cleanup_queue'), 'OpenClaw runtime tools must include traecn_cleanup_queue');
    checks.push({ name: 'agent-discovery-surfaces', ok: true });

    if (readiness.data && readiness.data.ready === true) {
      const sessionA = await request(port, 'POST', '/api/sessions', { projectPath: process.cwd() }, token);
      const sessionB = await request(port, 'POST', '/api/sessions', { projectPath: process.cwd() }, token);
      assert.strictEqual(sessionA.status, 201, 'session A should be created');
      assert.strictEqual(sessionB.status, 201, 'session B should be created');
      assert.notStrictEqual(sessionA.data.sessionId, sessionB.data.sessionId, 'multiple logical sessions must have distinct ids');
      const sessions = await request(port, 'GET', '/api/sessions', null, token);
      assert.strictEqual(sessions.status, 200, 'sessions list should return 200');
      assert.ok(sessions.data.sessions.some(session => session.id === sessionA.data.sessionId), 'sessions list should include session A');
      assert.ok(sessions.data.sessions.some(session => session.id === sessionB.data.sessionId), 'sessions list should include session B');
      const sessionADetails = await request(port, 'GET', `/api/sessions/${encodeURIComponent(sessionA.data.sessionId)}`, null, token);
      assert.strictEqual(sessionADetails.status, 200, 'session details should return 200');
      assert.deepStrictEqual(sessionADetails.data.messages, [], 'new session should start with no messages');
      checks.push({ name: 'logical-sessions', ok: true, created: 2 });

      const settingsModel = await request(port, 'GET', '/api/settings/read?section=%E6%A8%A1%E5%9E%8B', null, token);
      assert.strictEqual(settingsModel.status, 200, 'settings model read should return 200 when UI is ready');
      assert.ok(Array.isArray(settingsModel.data.items), 'settings model read should return items array');
      checks.push({ name: 'settings-read-model', ok: true, itemCount: settingsModel.data.items.length });

      const soloChats = await request(port, 'GET', '/api/solo/chats', null, token);
      assert.strictEqual(soloChats.status, 200, 'Solo chats list should return 200 when UI is ready');
      checks.push({ name: 'solo-chats-read', ok: true, mode: soloChats.data.mode, count: soloChats.data.count });

      const cleanupDryRun = await request(port, 'POST', '/api/solo/chats/cleanup-foreign-queue', {
        dryRun: true
      }, token);
      assert.strictEqual(cleanupDryRun.status, 200, 'cleanup dry-run should return 200 when UI is ready');
      assert.strictEqual(cleanupDryRun.data.support, 'delete_supported', 'cleanup dry-run should advertise delete support');
      await assertNoForeignQueueProbeChats(port, token, cleanupDryRun, checks);
    } else {
      checks.push({ name: 'logical-sessions', ok: true, skipped: true, reason: diagnostics.readiness.reason });
      checks.push({ name: 'settings-and-solo-live-read', ok: true, skipped: true, reason: diagnostics.readiness.reason });
    }

    if (allowDelegate) {
      const delegate = await request(port, 'POST', '/api/delegate-async', {
        task: delegateTask,
        waitForQueue: false,
        includeProcessText: false
      }, token, delegateTimeoutMs);
      assert.ok([200, 202].includes(delegate.status), 'delegate should return 200 or 202');
      checks.push({ name: 'delegate-async', ok: true, status: delegate.data.status || delegate.status });
    }

    if (exerciseBackgroundWorkflow) {
      assertReady(readiness.data, diagnostics, '--exercise-background-workflow');
      const workflowDelegate = await request(port, 'POST', '/api/delegate-async', {
        task: delegateTask,
        waitForQueue: true,
        reviewRequired: true,
        includeProcessText: false,
        followupTasks: [followupTask]
      }, token, delegateTimeoutMs);
      assert.strictEqual(workflowDelegate.status, 202, 'background workflow should queue or hold reviewable work');
      assert.ok(workflowDelegate.data.taskId, 'background workflow must return a taskId');
      checks.push({
        name: 'background-delegate',
        ok: true,
        taskId: workflowDelegate.data.taskId,
        status: workflowDelegate.data.status,
        followupCount: workflowDelegate.data.followupCount
      });

      const reviewSnapshot = await waitForTaskTerminalState(port, workflowDelegate.data.taskId, token, taskPollTimeoutMs);
      checks.push({
        name: 'background-task-terminal',
        ok: true,
        status: reviewSnapshot.status
      });
      assert.ok(['awaiting_review', 'approval_required', 'done'].includes(reviewSnapshot.status), `unexpected background task state: ${reviewSnapshot.status}`);

      if (reviewSnapshot.status === 'approval_required') {
        const err = new Error('Background workflow paused on approval_required; unexpected for live UAT');
        err.lastSnapshot = reviewSnapshot;
        throw err;
      }

      if (reviewSnapshot.status === 'awaiting_review') {
        const reviewResponse = await request(port, 'POST', `/api/task/${encodeURIComponent(workflowDelegate.data.taskId)}/review`, {
          decision: autoReviewDecision,
          notes: 'live-uat automatic review approval'
        }, token);
        assert.strictEqual(reviewResponse.status, 200, 'review endpoint should accept automatic decision');
        checks.push({
          name: 'background-review',
          ok: true,
          decision: autoReviewDecision,
          nextTaskId: reviewResponse.data.nextTaskId || null
        });

        if (reviewResponse.data.nextTaskId) {
          const followupSnapshot = await waitForTaskTerminalState(port, reviewResponse.data.nextTaskId, token, taskPollTimeoutMs);
          checks.push({
            name: 'background-followup-terminal',
            ok: true,
            status: followupSnapshot.status
          });
          assert.ok(['awaiting_review', 'done'].includes(followupSnapshot.status), `unexpected follow-up task state: ${followupSnapshot.status}`);
        }
      }
    }

    console.log('[live-uat] ' + JSON.stringify({
      status: 'PASS',
      cdp: { host: endpoint.host, port: endpoint.port, browser: endpoint.version.Browser || null },
      checks,
      diagnostics: buildDiagnostics(endpoint, lastStatusData, lastReadinessData)
    }, null, 2));
  } catch (err) {
    console.error('[live-uat] ' + JSON.stringify({
      status: 'FAIL',
      error: err.message,
      checks,
      diagnostics: err.diagnostics || buildDiagnostics(endpoint, lastStatusData, lastReadinessData)
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (gateway && typeof gateway.gracefulShutdown === 'function') {
      await gateway.gracefulShutdown();
    } else if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }

  process.exit(process.exitCode || 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[live-uat] FAIL:', err.message);
    process.exit(1);
  });
}

module.exports = { summarizeReadiness, buildDiagnostics, assertReady };
