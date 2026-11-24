'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-system-test-'));

process.env.TRAECN_ENABLE_MOCK_BRIDGE = '1';
process.env.TRAECN_GATEWAY_TOKEN = 'system-test-token';
process.env.TRAECN_RATE_LIMIT_MAX_REQUESTS = '1000';
process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = path.join(dataRoot, 'queue.json');
process.env.TRAECN_TASK_EVENT_PERSISTENCE_PATH = path.join(dataRoot, 'events.json');
process.env.TRAECN_TASK_HISTORY_PERSISTENCE_PATH = path.join(dataRoot, 'history.json');
process.env.TRAECN_AUDIT_LOG_DIR = path.join(dataRoot, 'audit');

const { startGateway } = require('../src/http/gateway');

function request(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      },
      timeout: 5000
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
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  let server;
  let close;
  try {
    ({ server, close } = await startGateway({ host: '127.0.0.1', port: 0 }));
    const port = server.address().port;
    const auth = { Authorization: 'Bearer system-test-token' };

    const status = await request(port, 'GET', '/api/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.data.mockBridge, true);
    assert.strictEqual(status.headers['x-content-type-options'], 'nosniff');

    const capabilities = await request(port, 'GET', '/api/capabilities');
    assert.strictEqual(capabilities.status, 200);
    assert.strictEqual(capabilities.data.name, 'traecn-mcp');
    assert.ok(capabilities.data.commands.some(command => command.command === 'delegate_async'));

    const unauthorized = await request(port, 'POST', '/api/sessions', {});
    assert.strictEqual(unauthorized.status, 401);

    const discoveredSettings = await request(port, 'GET', '/api/settings/read?section=general', null, auth);
    assert.strictEqual(discoveredSettings.status, 200);
    const settingBefore = discoveredSettings.data.items.find(item => item.visible !== false
      && item.controlType === 'toggle' && typeof item.toggleChecked === 'boolean');
    assert.ok(settingBefore?.label, 'mock settings must expose a discoverable toggle');
    const settingParams = { section: 'general', label: settingBefore.label, value: !settingBefore.toggleChecked };

    const confirmPlan = await request(port, 'POST', '/api/confirm/plan', {
      command: 'settings_set',
      params: settingParams
    }, auth);
    assert.strictEqual(confirmPlan.status, 200);
    assert.strictEqual(confirmPlan.data.risk, 'high');
    assert.strictEqual(confirmPlan.data.requiresConfirmation, true);

    const preflight = await request(port, 'POST', '/api/preflight', {
      command: 'delegate_async',
      params: { task: 'system test task' }
    }, auth);
    assert.strictEqual(preflight.status, 200);
    assert.strictEqual(preflight.data.connected, true);
    assert.strictEqual(preflight.data.commandPlan.command, 'delegate_async');
    assert.ok(preflight.data.nextAction);

    const blockedSetting = await request(port, 'POST', '/api/settings/set', {
      ...settingParams,
      kind: 'toggle',
      requireConfirmation: true
    }, auth);
    assert.strictEqual(blockedSetting.status, 409);
    assert.strictEqual(blockedSetting.data.code, 'OPERATION_CONFIRMATION_REQUIRED');

    const confirmedSetting = await request(port, 'POST', '/api/settings/set', {
      ...settingParams,
      kind: 'toggle',
      requireConfirmation: true,
      confirmationId: confirmPlan.data.confirmationId
    }, auth);
    assert.strictEqual(confirmedSetting.status, 200);
    assert.strictEqual(confirmedSetting.data.label, settingParams.label);
    assert.strictEqual(confirmedSetting.data.controlType, 'toggle');
    assert.strictEqual(confirmedSetting.data.requestedValue, settingParams.value);
    assert.strictEqual(confirmedSetting.data.value, settingParams.value);
    assert.strictEqual(confirmedSetting.data.verified, true);

    const settingsReadback = await request(port, 'GET', '/api/settings/read?section=general', null, auth);
    assert.strictEqual(settingsReadback.status, 200);
    const settingAfter = settingsReadback.data.items.find(item => item.label === settingParams.label);
    assert.strictEqual(settingAfter.toggleChecked, settingParams.value);
    assert.notStrictEqual(settingAfter.toggleChecked, settingBefore.toggleChecked);

    const missingParams = { ...settingParams, label: 'Missing system setting' };
    const missingPlan = await request(port, 'POST', '/api/confirm/plan', {
      command: 'settings_set', params: missingParams
    }, auth);
    assert.strictEqual(missingPlan.status, 200);
    const missingSetting = await request(port, 'POST', '/api/settings/set', {
      ...missingParams, kind: 'toggle', requireConfirmation: true,
      confirmationId: missingPlan.data.confirmationId
    }, auth);
    assert.strictEqual(missingSetting.status, 404);
    assert.strictEqual(missingSetting.data.error, 'setting_not_found');
    const invalidToggle = await request(port, 'POST', '/api/settings/set', {
      ...settingParams, kind: 'toggle', value: 'false'
    }, auth);
    assert.strictEqual(invalidToggle.status, 400);
    assert.strictEqual(invalidToggle.data.error, 'toggle value must be boolean');

    const session = await request(port, 'POST', '/api/sessions', {}, auth);
    assert.strictEqual(session.status, 201);
    assert.ok(session.data.sessionId);

    const delegate = await request(
      port,
      'POST',
      `/api/sessions/${encodeURIComponent(session.data.sessionId)}/delegate`,
      { task: 'system test task' },
      auth
    );
    assert.strictEqual(delegate.status, 200);
    assert.match(delegate.data.text, /^Mock response from TraeCN\./);
    assert.match(delegate.data.text, /No TraeCN model was called/);

    const asyncDelegate = await request(port, 'POST', '/api/delegate-async', { task: 'async task' }, auth);
    assert.strictEqual(asyncDelegate.status, 200);
    assert.strictEqual(asyncDelegate.data.text, delegate.data.text);

    const reviewedSubmission = await request(port, 'POST', '/api/tasks/submit', {
      message: 'Review the simulated system task',
      reviewRequired: true
    }, auth);
    assert.strictEqual(reviewedSubmission.status, 202);
    const reviewedTaskId = reviewedSubmission.data.taskId;
    assert.ok(reviewedTaskId);
    const reviewDeadline = Date.now() + 45000;
    let reviewSnapshot;
    do {
      reviewSnapshot = await request(port, 'GET', `/api/task/${reviewedTaskId}`, null, auth);
      assert.strictEqual(reviewSnapshot.status, 200);
      if (reviewSnapshot.data.status !== 'queued' && reviewSnapshot.data.status !== 'executing') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < reviewDeadline);
    assert.strictEqual(reviewSnapshot.data.status, 'awaiting_review', 'manual review must not be automatically approved');
    assert.strictEqual(reviewSnapshot.data.result.text, delegate.data.text);
    const approved = await request(port, 'POST', `/api/task/${reviewedTaskId}/review`, {
      decision: 'approve',
      notes: 'Reviewed in the isolated mock system test'
    }, auth);
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(approved.data.taskId, reviewedTaskId);
    assert.strictEqual(approved.data.status, 'done');
    const finalSnapshot = await request(port, 'GET', `/api/task/${reviewedTaskId}`, null, auth);
    assert.strictEqual(finalSnapshot.data.status, 'done');
    assert.strictEqual(finalSnapshot.data.result.text, delegate.data.text);

    const queueStatus = await request(port, 'GET', '/api/queue-status', null, auth);
    assert.strictEqual(queueStatus.status, 200);
    assert.strictEqual(queueStatus.data.queued, false);

    const mode = await request(port, 'GET', '/api/detect-mode', null, auth);
    assert.strictEqual(mode.status, 200);
    assert.strictEqual(mode.data.mode, 'solo');

    const switchMode = await request(port, 'POST', '/api/switch-mode', { mode: 'ide' }, auth);
    assert.strictEqual(switchMode.status, 200);
    assert.strictEqual(switchMode.data.success, true);

    const switchModel = await request(port, 'POST', '/api/switch-model', { model: 'glm' }, auth);
    assert.strictEqual(switchModel.status, 200);
    assert.strictEqual(switchModel.data.success, true);

    const settings = await request(port, 'GET', '/api/settings/read?section=general', null, auth);
    assert.strictEqual(settings.status, 200);
    assert.ok(Array.isArray(settings.data.items));

    const dialog = await request(port, 'GET', '/api/dialog/status', null, auth);
    assert.strictEqual(dialog.status, 200);
    assert.strictEqual(dialog.data.hasDialog, false);

    console.log('[system-test] PASS');
  } catch (err) {
    console.error('[system-test] FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    // Always go through the gateway's full shutdown path — that drains
    // background polling, the CDP health watcher, the WebSocket heartbeat,
    // and the CDP client before letting the HTTP server close. Without this,
    // intervals keep the event loop alive past the assertions and the
    // process hangs until the OS SIGKILLs it (exit code 137).
    if (typeof close === 'function') {
      try {
        await close();
      } catch (e) {
        console.error('[system-test] shutdown error:', e.message);
      }
    } else if (server) {
      // Defensive fallback for older startGateway return shapes.
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
})();
