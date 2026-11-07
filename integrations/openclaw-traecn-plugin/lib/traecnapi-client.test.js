'use strict';

const assert = require('assert');
const http = require('http');
const {
  TraeCNApiClient,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT,
  DEFAULT_TASK_POLL_MS,
  isTerminalTaskStatus
} = require('./traecnapi-client');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log('\n[traecnapi-client.test.js] Running tests...\n');

test('DEFAULT_HOST is 127.0.0.1', () => {
  assert.strictEqual(DEFAULT_HOST, '127.0.0.1');
});

test('DEFAULT_PORT is 8788', () => {
  assert.strictEqual(DEFAULT_PORT, 8788);
});

test('DEFAULT_TIMEOUT is 120000', () => {
  assert.strictEqual(DEFAULT_TIMEOUT, 120000);
});

test('DEFAULT_TASK_POLL_MS is suitable for long local waits', () => {
  assert.strictEqual(DEFAULT_TASK_POLL_MS, 30000);
});

test('isTerminalTaskStatus recognizes task wait stopping points', () => {
  assert.strictEqual(isTerminalTaskStatus('done'), true);
  assert.strictEqual(isTerminalTaskStatus('approval_required'), true);
  assert.strictEqual(isTerminalTaskStatus('executing'), false);
});

test('TraeCNApiClient constructor uses defaults', () => {
  const client = new TraeCNApiClient();
  assert.strictEqual(client.host, DEFAULT_HOST);
  assert.strictEqual(client.port, DEFAULT_PORT);
  assert.strictEqual(client.token, '');
  assert.strictEqual(client.timeout, DEFAULT_TIMEOUT);
});

test('TraeCNApiClient constructor accepts custom options', () => {
  const client = new TraeCNApiClient({ host: '10.0.0.1', port: 9999, token: 'abc', timeout: 5000 });
  assert.strictEqual(client.host, '10.0.0.1');
  assert.strictEqual(client.port, 9999);
  assert.strictEqual(client.token, 'abc');
  assert.strictEqual(client.timeout, 5000);
});

(async () => {
  let server;
  let lastRequest;

  function createMockServer(handler) {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          lastRequest = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body ? JSON.parse(body) : null
          };
          handler(req, res, lastRequest.body);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address().port);
      });
    });
  }

  await asyncTest('getStatus sends GET to /api/status', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'connected' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.getStatus();
    assert.strictEqual(result.data.status, 'connected');
    assert.strictEqual(lastRequest.method, 'GET');
    assert.strictEqual(lastRequest.url, '/api/status?allowAutoStart=false');
    server.close();
  });

  await asyncTest('getCapabilities sends GET to /api/capabilities', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'traecnclaw', commands: [] }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.getCapabilities();
    assert.strictEqual(result.data.name, 'traecnclaw');
    assert.strictEqual(lastRequest.method, 'GET');
    assert.strictEqual(lastRequest.url, '/api/capabilities');
    server.close();
  });

  await asyncTest('createConfirmationPlan sends POST to /api/confirm/plan', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ command: 'settings_set', risk: 'high' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.createConfirmationPlan('settings_set', { label: 'Auto Save', value: true });
    assert.strictEqual(result.data.risk, 'high');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/confirm/plan');
    assert.strictEqual(lastRequest.body.command, 'settings_set');
    server.close();
  });

  await asyncTest('preflight sends POST to /api/preflight', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: true, nextAction: 'delegate_async' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.preflight({ command: 'delegate_async', params: { task: 'test' } });
    assert.strictEqual(result.data.nextAction, 'delegate_async');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/preflight');
    assert.strictEqual(lastRequest.body.command, 'delegate_async');
    assert.strictEqual(lastRequest.body.params.task, 'test');
    server.close();
  });

  await asyncTest('restartTraeDebug sends confirmed POST to /api/trae/restart-debug', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: 'restart_trae_debug' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.restartTraeDebug({
      confirmationPhrase: 'restart-trae-cn-with-debug-existing-profile',
      cdpWaitMs: 1000
    });
    assert.strictEqual(result.data.action, 'restart_trae_debug');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/trae/restart-debug');
    assert.strictEqual(lastRequest.body.confirmationPhrase, 'restart-trae-cn-with-debug-existing-profile');
    assert.strictEqual(lastRequest.body.cdpWaitMs, 1000);
    server.close();
  });

  await asyncTest('openProject forwards newInstance to the gateway', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ opened: true }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });

    await client.openProject('/tmp/second-project', { newInstance: true });

    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/open-project');
    assert.deepStrictEqual(lastRequest.body, {
      projectPath: '/tmp/second-project',
      newInstance: true
    });
    server.close();
  });

  await asyncTest('stopGeneration sends POST to /api/trae/stop-generation', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.stopGeneration({
      conversationId: 'solo:Q3VycmVudCB0YXNr',
      acknowledgeUntrackedWork: true,
      reason: 'Stop requested by user'
    });
    assert.strictEqual(result.data.success, true);
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/trae/stop-generation');
    assert.deepStrictEqual(lastRequest.body, {
      conversationId: 'solo:Q3VycmVudCB0YXNr',
      acknowledgeUntrackedWork: true,
      reason: 'Stop requested by user'
    });
    server.close();
  });

  await asyncTest('listSoloChats sends GET to /api/solo/chats', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode: 'solo', chats: [], count: 0 }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.listSoloChats();
    assert.strictEqual(result.data.mode, 'solo');
    assert.strictEqual(lastRequest.method, 'GET');
    assert.strictEqual(lastRequest.url, '/api/solo/chats');
    server.close();
  });

  await asyncTest('switchSoloChat sends POST to /api/solo/chats/switch', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, index: 1 }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.switchSoloChat({ index: 1, titleIncludes: 'Feature' });
    assert.strictEqual(result.data.success, true);
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/solo/chats/switch');
    assert.strictEqual(lastRequest.body.index, 1);
    assert.strictEqual(lastRequest.body.titleIncludes, 'Feature');
    server.close();
  });

  await asyncTest('cleanupForeignSoloQueue sends POST to cleanup endpoint', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ matched: 1, deleted: 1 }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.cleanupForeignSoloQueue({ execute: true, maxPasses: 10, settleMs: 250 });
    assert.strictEqual(result.data.deleted, 1);
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/solo/chats/cleanup-foreign-queue');
    assert.strictEqual(lastRequest.body.execute, true);
    assert.strictEqual(lastRequest.body.dryRun, false);
    assert.strictEqual(lastRequest.body.maxPasses, 10);
    assert.strictEqual(lastRequest.body.settleMs, 250);
    server.close();
  });

  await asyncTest('submitSoloChatTask sends POST to /api/solo/chats/submit', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_solo_1', status: 'executing' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.submitSoloChatTask('Build feature', {
      projectPath: '/tmp/project',
      soloChat: { titleIncludes: 'Feature chat' },
      includeProcessText: true
    });
    assert.strictEqual(result.data.taskId, 'task_solo_1');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/solo/chats/submit');
    assert.strictEqual(lastRequest.body.task, 'Build feature');
    assert.strictEqual(lastRequest.body.projectPath, '/tmp/project');
    assert.strictEqual(lastRequest.body.soloChat.titleIncludes, 'Feature chat');
    assert.strictEqual(lastRequest.body.includeProcessText, true);
    server.close();
  });

  await asyncTest('adoptCurrentTask sends POST to /api/task/adopt-current', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_adopted', status: 'executing' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.adoptCurrentTask({
      task: 'review repo',
      reviewRequired: true,
      force: true
    });
    assert.strictEqual(result.data.taskId, 'task_adopted');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/task/adopt-current');
    assert.strictEqual(lastRequest.body.task, 'review repo');
    assert.strictEqual(lastRequest.body.reviewRequired, true);
    assert.strictEqual(lastRequest.body.force, true);
    server.close();
  });

  await asyncTest('waitForTask polls until terminal status and reports attempts', async () => {
    let calls = 0;
    const snapshots = [];
    const port = await createMockServer((req, res) => {
      calls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (calls === 1) {
        res.end(JSON.stringify({ taskId: 'task_wait', status: 'queued' }));
      } else {
        res.end(JSON.stringify({ taskId: 'task_wait', status: 'done', result: { text: 'complete' } }));
      }
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.waitForTask('task_wait', {
      pollMs: 1,
      onSnapshot: event => snapshots.push(event)
    });
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.result.text, 'complete');
    assert.strictEqual(result.wait.attempts, 2);
    assert.deepStrictEqual(snapshots.map(event => event.status), ['queued', 'done']);
    server.close();
  });

  await asyncTest('waitForTask can approve a dialog before continuing', async () => {
    let taskCalls = 0;
    const urls = [];
    const port = await createMockServer((req, res) => {
      urls.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/dialog/status') {
        res.end(JSON.stringify({ hasDialog: true, dialogType: 'review_scope_question' }));
        return;
      }
      if (req.url === '/api/dialog/approve') {
        res.end(JSON.stringify({ success: true }));
        return;
      }
      taskCalls++;
      if (taskCalls === 1) {
        res.end(JSON.stringify({ taskId: 'task_dialog', status: 'approval_required' }));
        return;
      }
      res.end(JSON.stringify({ taskId: 'task_dialog', status: 'done', result: { text: 'approved' } }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.waitForTask('task_dialog', {
      pollMs: 1,
      autoApproveDialog: 'auto'
    });
    assert.strictEqual(result.status, 'done');
    assert.ok(urls.includes('/api/dialog/status'));
    assert.ok(urls.includes('/api/dialog/approve'));
    server.close();
  });

  await asyncTest('review gate helpers use /api/trae/review-gate', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    await client.getReviewGateStatus();
    assert.strictEqual(lastRequest.method, 'GET');
    assert.strictEqual(lastRequest.url, '/api/trae/review-gate');

    await client.resolveReviewGate('keep_all');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/trae/review-gate');
    assert.strictEqual(lastRequest.body.action, 'keep_all');
    server.close();
  });

  await asyncTest('delegate sends POST to /api/delegate', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'response', stable: true }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.delegate('test task', {
      includeProcessText: true,
      waitForQueue: false,
      fallbackModels: ['GLM-5.1'],
      autoModelFallback: true,
      modelProbeIntervalMs: 15000
    });
    assert.strictEqual(result.text, 'response');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/delegate');
    assert.strictEqual(lastRequest.body.task, 'test task');
    assert.strictEqual(lastRequest.body.includeProcessText, true);
    assert.strictEqual(lastRequest.body.waitForQueue, false);
    assert.deepStrictEqual(lastRequest.body.fallbackModels, ['GLM-5.1']);
    assert.strictEqual(lastRequest.body.autoModelFallback, true);
    assert.strictEqual(lastRequest.body.modelProbeIntervalMs, 15000);
    server.close();
  });

  await asyncTest('delegateAsync sends fallback model options', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_1', status: 'queued' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.delegateAsync('queued task', {
      fallbackModels: ['GLM-5.1', 'Kimi-K2.6'],
      modelProbeIntervalMs: 30000
    });
    assert.strictEqual(result.data.taskId, 'task_1');
    assert.strictEqual(lastRequest.url, '/api/delegate-async');
    assert.deepStrictEqual(lastRequest.body.fallbackModels, ['GLM-5.1', 'Kimi-K2.6']);
    assert.strictEqual(lastRequest.body.modelProbeIntervalMs, 30000);
    server.close();
  });

  await asyncTest('delegateAsync sends background execution option', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_bg', status: 'queued' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.delegateAsync('long task', { background: true });
    assert.strictEqual(result.data.taskId, 'task_bg');
    assert.strictEqual(lastRequest.url, '/api/delegate-async');
    assert.strictEqual(lastRequest.body.background, true);
    server.close();
  });

  await asyncTest('delegateAsync sends unattended workflow options', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_workflow', status: 'queued' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.delegateAsync('implement feature', {
      projectPath: '/tmp/project',
      reviewRequired: false,
      autoContinue: true,
      followupTasks: [{ task: 'run tests', reviewRequired: false, autoContinue: true }],
      completionChecks: { requiredFiles: ['FINAL_REPORT.md'] },
      autoApproveDialog: 'auto',
      notifyUrl: 'https://example.test/hook',
      maxQueueWaitMs: 600000
    });
    assert.strictEqual(result.data.taskId, 'task_workflow');
    assert.strictEqual(lastRequest.url, '/api/delegate-async');
    assert.strictEqual(lastRequest.body.projectPath, '/tmp/project');
    assert.strictEqual(lastRequest.body.autoContinue, true);
    assert.deepStrictEqual(lastRequest.body.followupTasks, [{ task: 'run tests', reviewRequired: false, autoContinue: true }]);
    assert.deepStrictEqual(lastRequest.body.completionChecks, { requiredFiles: ['FINAL_REPORT.md'] });
    assert.strictEqual(lastRequest.body.autoApproveDialog, 'auto');
    assert.strictEqual(lastRequest.body.notifyUrl, 'https://example.test/hook');
    assert.strictEqual(lastRequest.body.maxQueueWaitMs, 600000);
    server.close();
  });

  await asyncTest('delegateAsync forwards Solo chat targeting options', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_solo_targeted', status: 'queued' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    await client.delegateAsync('Target Solo task', {
      soloChatTitleIncludes: 'Feature chat',
      newChat: false
    });
    assert.strictEqual(lastRequest.url, '/api/delegate-async');
    assert.strictEqual(lastRequest.body.soloChatTitleIncludes, 'Feature chat');
    assert.strictEqual(lastRequest.body.newChat, false);
    server.close();
  });

  await asyncTest('delegateAsync forwards session and long-queue ownership options', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_owned_queue', status: 'queued' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    await client.delegateAsync('Owned queue task', {
      sessionId: 'session_a',
      soloChat: { titleIncludes: 'Feature chat' },
      forceBackground: true,
      maxQueueWaitMs: 3600000,
      queueMaxWaitMs: 3600000
    });
    assert.strictEqual(lastRequest.url, '/api/delegate-async');
    assert.strictEqual(lastRequest.body.sessionId, 'session_a');
    assert.deepStrictEqual(lastRequest.body.soloChat, { titleIncludes: 'Feature chat' });
    assert.strictEqual(lastRequest.body.forceBackground, true);
    assert.strictEqual(lastRequest.body.maxQueueWaitMs, 3600000);
    assert.strictEqual(lastRequest.body.queueMaxWaitMs, 3600000);
    server.close();
  });

  await asyncTest('switchModel sends POST to /api/switch-model', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, model: 'GLM-5.1' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.switchModel('GLM-5.1', { waitForQueue: false });
    assert.strictEqual(result.data.success, true);
    assert.strictEqual(lastRequest.body.model, 'GLM-5.1');
    assert.strictEqual(lastRequest.body.waitForQueue, false);
    server.close();
  });

  await asyncTest('checkQueueStatus sends GET to /api/queue-status', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: false }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.checkQueueStatus();
    assert.strictEqual(result.data.queued, false);
    assert.strictEqual(lastRequest.url, '/api/queue-status');
    server.close();
  });

  await asyncTest('settingsRead sends GET with section param', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ section: '模型' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.settingsRead('模型');
    assert.strictEqual(result.data.section, '模型');
    assert.ok(lastRequest.url.startsWith('/api/settings/read?section='));
    server.close();
  });

  await asyncTest('settingsWrite sends POST to settings set endpoint', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ label: 'Auto Save', value: true }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.settingsWrite('通用', { label: 'Auto Save', value: true });
    assert.strictEqual(result.data.label, 'Auto Save');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/settings/set');
    assert.strictEqual(lastRequest.body.section, '通用');
    server.close();
  });

  await asyncTest('settingsWrite can send confirmation metadata', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    await client.settingsWrite('通用', { label: 'Auto Save', value: true }, {
      confirmationId: 'confirm_1',
      requireConfirmation: true
    });
    assert.strictEqual(lastRequest.body.confirmationId, 'confirm_1');
    assert.strictEqual(lastRequest.body.requireConfirmation, true);
    server.close();
  });

  await asyncTest('settingsAction maps navigate to implemented settings switch-tab endpoint', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ section: 'MCP' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.settingsAction('navigate', { section: 'MCP' });
    assert.strictEqual(result.data.section, 'MCP');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/settings/switch-tab');
    assert.strictEqual(lastRequest.body.section, 'MCP');
    server.close();
  });

  await asyncTest('settingsAction maps readTables to implemented read-all endpoint', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sections: ['通用'] }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.settingsAction('readTables');
    assert.deepStrictEqual(result.data.sections, ['通用']);
    assert.strictEqual(lastRequest.method, 'GET');
    assert.strictEqual(lastRequest.url, '/api/settings/read-all');
    server.close();
  });

  await asyncTest('batch helpers use implemented batch endpoints', async () => {
    const port = await createMockServer((req, res, body) => {
      if (req.method === 'POST') {
        assert.deepStrictEqual(body.tasks, [{ task: 'one' }]);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ batchId: 'batch_1' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ batchId: 'batch_1', status: 'completed' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const submit = await client.submitBatch([{ task: 'one' }], { strategy: 'sequential', maxConcurrency: 1 });
    assert.strictEqual(submit.data.batchId, 'batch_1');
    assert.strictEqual(lastRequest.url, '/api/tasks/batch');
    assert.strictEqual(lastRequest.body.strategy, 'sequential');

    const status = await client.getBatchStatus('batch_1');
    assert.strictEqual(status.data.status, 'completed');
    assert.strictEqual(lastRequest.url, '/api/tasks/batch/batch_1');
    server.close();
  });

  await asyncTest('token is sent as Bearer auth header', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const client = new TraeCNApiClient({ port, token: 'test-token', timeout: 3000 });
    await client.getStatus();
    assert.strictEqual(lastRequest.headers.authorization, 'Bearer test-token');
    server.close();
  });

  await asyncTest('healthCheck returns true for 200', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'connected' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.healthCheck();
    assert.strictEqual(result, true);
    server.close();
  });

  await asyncTest('healthCheck returns false for connection error', async () => {
    const client = new TraeCNApiClient({ port: 1, timeout: 500 });
    const result = await client.healthCheck();
    assert.strictEqual(result, false);
  });

  console.log(`\n[traecnapi-client.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
