'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const { loadEnv } = require('../src/config/env');
const { resolveCDPEndpoint } = require('../src/cdp/discovery');
const { startGateway } = require('../src/http/gateway');

loadEnv(path.resolve(__dirname, '..', '.env'));

const strict = process.argv.includes('--strict');
const requireReady = process.argv.includes('--require-ready');
const allowDelegate = process.argv.includes('--delegate');
const exerciseBackgroundWorkflow = process.argv.includes('--exercise-background-workflow');
const autoReviewDecision = readArg('--auto-review-decision') || 'approve';
const delegateTask = readArg('--delegate-task') || '请用一句话回复 TRAECNclaw live UAT ready';
const delegateTimeoutMs = Number(readArg('--delegate-timeout-ms') || 120000);
const taskPollIntervalMs = Number(readArg('--task-poll-interval-ms') || 5000);
const taskPollTimeoutMs = Number(readArg('--task-poll-timeout-ms') || 240000);
const followupTask = readArg('--followup-task') || '请只回复 FOLLOWUP_REVIEW_OK';

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

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
        } catch {}
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
  if (!data || typeof data !== 'object') {
    return { ready: false, reason: 'readiness response was not an object' };
  }
  if (data.ready === true) return { ready: true };

  const missing = [];
  for (const [key, value] of Object.entries(data.checks || {})) {
    if (value === false || value === null || value === undefined) missing.push(key);
  }

  return {
    ready: false,
    reason: data.reason || data.error || (missing.length ? `missing UI checks: ${missing.join(', ')}` : 'Trae CN UI is not ready for automation'),
    missing,
    currentMode: data.currentMode || null,
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
      mockBridge: statusData?.mockBridge === true
    },
    surface,
    readiness,
    nextSteps: readiness.ready ? [] : [
      surface?.kind === 'setup'
        ? 'Finish the current Trae CN setup or login flow until the main workspace appears.'
        : 'Open Trae CN in the debug-enabled instance and complete login/onboarding.',
      'Open or focus a chat/project window with the message composer visible.',
      'Run npm run inspect:verify if readiness stays false after the UI is visible.',
      'Use node scripts/live-uat.js --require-ready for a strict readiness gate, and add --delegate only when sending a real prompt is acceptable.'
    ]
  };
}

function assertReady(readinessData, diagnostics, gateName) {
  if (readinessData && readinessData.ready === true) return;
  const err = new Error(`${gateName} requires Trae CN UI readiness; ${diagnostics.readiness.reason}`);
  err.diagnostics = diagnostics;
  throw err;
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

  const token = process.env.TRAECN_GATEWAY_TOKEN || '';
  let server;
  const checks = [];
  let lastStatusData = null;
  let lastReadinessData = null;
  try {
    const started = await startGateway({ host: '127.0.0.1', port: 0 });
    server = started.server;
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
    assert.strictEqual(capabilities.data.coverage?.queueManagement, true, 'capabilities must advertise queue management');
    checks.push({ name: 'capabilities', ok: true, commands: capabilities.data.commands.length });

    const confirmationPlan = await request(port, 'POST', '/api/confirm/plan', {
      command: 'approve_dialog',
      params: { action: 'trust' }
    }, token);
    assert.strictEqual(confirmationPlan.status, 200, 'confirmation plan endpoint should return 200');
    assert.strictEqual(confirmationPlan.data.risk, 'high', 'approve_dialog must be high risk');
    assert.strictEqual(confirmationPlan.data.requiresConfirmation, true, 'approve_dialog must require confirmation');
    checks.push({ name: 'confirmation-plan', ok: true, risk: confirmationPlan.data.risk });

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
    checks.push({ name: 'openapi', ok: true, paths: Object.keys(openapi.data.paths).length });

    const diagnostics = buildDiagnostics(endpoint, lastStatusData, lastReadinessData);
    if (requireReady) {
      assertReady(readiness.data, diagnostics, '--require-ready');
      checks.push({ name: 'require-ready', ok: true });
    }

    if (allowDelegate) {
      assertReady(readiness.data, diagnostics, '--delegate');
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
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

main().catch(err => {
  console.error('[live-uat] FAIL:', err.message);
  process.exit(1);
});
