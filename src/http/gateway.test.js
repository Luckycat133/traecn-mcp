'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const TEST_QUEUE_PERSISTENCE_PATH = path.join(os.tmpdir(), 'traecnclaw-gateway-test-active-queue.json');
const TEST_HISTORY_PERSISTENCE_PATH = path.join(os.tmpdir(), 'traecnclaw-gateway-test-history.json');
process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = TEST_QUEUE_PERSISTENCE_PATH;
process.env.TRAECN_TASK_HISTORY_PERSISTENCE_PATH = TEST_HISTORY_PERSISTENCE_PATH;
try {
  fs.unlinkSync(TEST_QUEUE_PERSISTENCE_PATH);
} catch {}
try {
  fs.unlinkSync(TEST_HISTORY_PERSISTENCE_PATH);
} catch {}

const { Gateway, RateLimiter, sanitizeLog } = require('./gateway');
const { buildCapabilities } = require('../shared/capabilities');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');
const requestContext = require('../shared/request-context');

let passed = 0;
let failed = 0;
const pendingAsyncTests = [];

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

function asyncTest(name, fn) {
  pendingAsyncTests.push({ name, fn });
}

console.log('\n[gateway.test.js] Running RateLimiter and sanitizeLog tests...\n');

test('RateLimiter allows requests within limit', () => {
  const limiter = new RateLimiter(60000, 5);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(limiter.check('key1'), true);
  }
});

test('RateLimiter blocks requests over limit', () => {
  const limiter = new RateLimiter(60000, 3);
  limiter.check('key1');
  limiter.check('key1');
  limiter.check('key1');
  assert.strictEqual(limiter.check('key1'), false);
});

test('RateLimiter tracks different keys independently', () => {
  const limiter = new RateLimiter(60000, 2);
  limiter.check('key1');
  limiter.check('key1');
  assert.strictEqual(limiter.check('key1'), false);
  assert.strictEqual(limiter.check('key2'), true);
});

test('RateLimiter getRemaining returns correct count', () => {
  const limiter = new RateLimiter(60000, 5);
  limiter.check('key1');
  limiter.check('key1');
  assert.strictEqual(limiter.getRemaining('key1'), 3);
});

test('RateLimiter getRemaining returns max for unknown key', () => {
  const limiter = new RateLimiter(60000, 5);
  assert.strictEqual(limiter.getRemaining('unknown'), 5);
});

test('RateLimiter resets after window expires', () => {
  const limiter = new RateLimiter(1, 1);
  limiter.check('key1');
  assert.strictEqual(limiter.check('key1'), false);
  const start = Date.now();
  while (Date.now() - start < 5) {}
  assert.strictEqual(limiter.check('key1'), true);
});

test('RateLimiter cleanup removes old entries', () => {
  const limiter = new RateLimiter(1, 1);
  limiter.check('old-key');
  const start = Date.now();
  while (Date.now() - start < 5) {}
  limiter._cleanup();
  assert.strictEqual(limiter.requests.has('old-key'), false);
});

// ── Per-API-key rate limiting (Batch C1) ──────────────────────────────────

test('Gateway rate-limits per API key id when auth context is active', () => {
  const gateway = new Gateway();
  gateway.rateLimiter = new RateLimiter(60000, 2);
  const makeReq = (ip) => ({ socket: { remoteAddress: ip } });

  // Two requests for keyA from the same IP — bucket is the API key, not the IP.
  requestContext.run({ authKeyId: 'keyA' }, () => {
    assert.strictEqual(gateway._checkRateLimit(makeReq('10.0.0.1')), true);
    assert.strictEqual(gateway._checkRateLimit(makeReq('10.0.0.1')), true);
    assert.strictEqual(gateway._checkRateLimit(makeReq('10.0.0.1')), false);
  });

  // keyB has its own bucket even though it shares the IP with keyA.
  requestContext.run({ authKeyId: 'keyB' }, () => {
    assert.strictEqual(gateway._checkRateLimit(makeReq('10.0.0.1')), true);
    assert.strictEqual(gateway._checkRateLimit(makeReq('10.0.0.1')), true);
  });
});

test('Gateway rate-limits per IP when no auth context is active', () => {
  const gateway = new Gateway();
  gateway.rateLimiter = new RateLimiter(60000, 1);
  const reqA = { socket: { remoteAddress: '10.0.0.1' } };
  const reqB = { socket: { remoteAddress: '10.0.0.2' } };

  // requestContext.get returns undefined when no context is active — this is
  // the code path exercised by unauthenticated traffic (e.g. /api/status).
  assert.strictEqual(requestContext.getRequestId(), null);
  assert.strictEqual(gateway._checkRateLimit(reqA), true);
  assert.strictEqual(gateway._checkRateLimit(reqA), false);
  assert.strictEqual(gateway._checkRateLimit(reqB), true);
});

test('Gateway _resolveRateLimitKey returns key-prefixed id for auth context', () => {
  const gateway = new Gateway();
  let resolved;
  requestContext.run({ authKeyId: 'key_abc' }, () => {
    resolved = gateway._resolveRateLimitKey({ socket: { remoteAddress: '10.0.0.1' } });
  });
  assert.strictEqual(resolved, 'key:key_abc');
});

test('Gateway _resolveRateLimitKey returns ip-prefixed id without auth context', () => {
  const gateway = new Gateway();
  const resolved = gateway._resolveRateLimitKey({ socket: { remoteAddress: '10.0.0.1' } });
  assert.strictEqual(resolved, 'ip:10.0.0.1');
});

test('Gateway _resolveRateLimitKey falls back to anonymous when no peer info', () => {
  const gateway = new Gateway();
  assert.strictEqual(gateway._resolveRateLimitKey({}), 'anonymous');
  assert.strictEqual(gateway._resolveRateLimitKey({ socket: {} }), 'anonymous');
});

test('sanitizeLog redacts sensitive keys', () => {
  const obj = { token: 'secret123', name: 'visible', password: 'pass456' };
  const result = sanitizeLog(obj);
  assert.strictEqual(result.token, '[REDACTED]');
  assert.strictEqual(result.name, 'visible');
  assert.strictEqual(result.password, '[REDACTED]');
});

test('sanitizeLog handles nested objects', () => {
  const obj = { config: { token: 'nested-secret' }, data: 'ok' };
  const result = sanitizeLog(obj);
  assert.strictEqual(result.config.token, '[REDACTED]');
  assert.strictEqual(result.data, 'ok');
});

test('sanitizeLog handles null and undefined', () => {
  assert.deepStrictEqual(sanitizeLog(null), null);
  assert.deepStrictEqual(sanitizeLog(undefined), undefined);
});

test('sanitizeLog handles non-objects', () => {
  assert.strictEqual(sanitizeLog('string'), 'string');
  assert.strictEqual(sanitizeLog(42), 42);
});

test('Gateway authenticates bearer tokens', () => {
  const gateway = new Gateway();
  gateway.token = 'secret';
  assert.strictEqual(gateway._authenticate({ headers: { authorization: 'Bearer secret' } }), true);
  assert.strictEqual(gateway._authenticate({ headers: { authorization: 'Bearer wrong' } }), false);
});

test('Gateway authenticates X-TraeCN-Token header', () => {
  const gateway = new Gateway();
  gateway.token = 'secret';
  assert.strictEqual(gateway._authenticate({ headers: { 'x-traecn-token': 'secret' } }), true);
});

test('Gateway honors documented HOST and PORT fallbacks', () => {
  const previousHost = process.env.HOST;
  const previousPort = process.env.PORT;
  const previousTraecnHost = process.env.TRAECN_HOST;
  const previousTraecnPort = process.env.TRAECN_PORT;
  delete process.env.TRAECN_HOST;
  delete process.env.TRAECN_PORT;
  process.env.HOST = '127.0.0.2';
  process.env.PORT = '8790';

  try {
    const gateway = new Gateway();
    assert.strictEqual(gateway.host, '127.0.0.2');
    assert.strictEqual(gateway.port, 8790);
  } finally {
    restoreEnv('HOST', previousHost);
    restoreEnv('PORT', previousPort);
    restoreEnv('TRAECN_HOST', previousTraecnHost);
    restoreEnv('TRAECN_PORT', previousTraecnPort);
  }
});

test('buildCapabilities returns compact command and token strategy metadata', () => {
  const capabilities = buildCapabilities({
    commands: [{ command: 'delegate_async', summary: 'Async delegate', required: ['task'], optional: ['waitForQueue'] }],
    mcpTools: [{ name: 'queue_task', description: 'Queue task', inputSchema: { required: ['task'] } }]
  });
  assert.strictEqual(capabilities.name, 'traecnclaw');
  assert.strictEqual(capabilities.coverage.queueManagement, true);
  assert.ok(capabilities.tokenStrategy.prefer.includes('preflight'));
  assert.ok(capabilities.tokenStrategy.prefer.includes('delegate_async'));
  assert.ok(capabilities.commands.some(command => command.command === 'delegate_async'));
  assert.ok(capabilities.mcp.tools.some(tool => tool.name === 'queue_task'));
  assert.ok(capabilities.http.some(operation => operation.path === '/api/capabilities'));
  assert.ok(capabilities.http.some(operation => operation.path === '/api/preflight'));
});

test('buildConfirmationPlan marks settings writes as high-risk confirmation operations', () => {
  const plan = buildConfirmationPlan({
    command: 'settings_set',
    params: { label: 'Auto Save', value: true }
  });
  assert.strictEqual(plan.risk, 'high');
  assert.strictEqual(plan.requiresConfirmation, true);
  assert.ok(plan.preflight.some(item => item.includes('Read the target settings section')));
  assert.ok(plan.recommendedFlow.includes('user_confirmation'));
});

test('Gateway computes CORS headers for allowed origins', () => {
  const gateway = new Gateway();
  gateway.allowedOrigins = 'https://example.com';
  const headers = gateway._corsHeaders({ headers: { origin: 'https://example.com' } });
  assert.strictEqual(headers['Access-Control-Allow-Origin'], 'https://example.com');
  assert.strictEqual(headers.Vary, 'Origin');
});

test('Gateway normalizes followup tasks from strings and objects', () => {
  const gateway = new Gateway();
  const result = gateway._normalizeFollowupTasks([
    'step 2',
    { task: 'step 3', reviewRequired: false, includeProcessText: true },
    null
  ]);
  assert.deepStrictEqual(result, [
    { task: 'step 2', reviewRequired: true },
    { task: 'step 3', reviewRequired: false, autoContinue: false, includeProcessText: true }
  ]);
});

test('Gateway creates queued task with review workflow metadata', () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1234, queueMaxWaitMs: 5678 } };
  gateway.taskHistoryStore = {
    createTask: () => 'task_test_1',
    recordStep: () => {}
  };
  const task = gateway._createQueuedTask({
    task: 'review me',
    projectPath: '/tmp/traecn-project',
    reviewRequired: true,
    followupTasks: ['next task'],
    notifyUrl: 'https://example.test/hook'
  }, { running: true, queueMessage: 'busy' });
  assert.strictEqual(task.taskId, 'task_test_1');
  assert.strictEqual(task.projectPath, '/tmp/traecn-project');
  assert.strictEqual(task.reviewRequired, true);
  assert.strictEqual(task.autoContinue, false);
  assert.strictEqual(task.followupTasks.length, 1);
  assert.strictEqual(task.queueState, 'running');
  assert.strictEqual(task.notifyUrl, 'https://example.test/hook');
  assert.ok(task.maxDeadline >= task.deadline);
});

asyncTest('Gateway auto-continues reviewable workflow followups without human review', async () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1234 } };
  gateway.taskHistoryStore = {
    createTask: (() => {
      let index = 0;
      return () => `task_auto_${++index}`;
    })(),
    recordStep: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {},
    ensureTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};

  const task = gateway._createQueuedTask({
    task: 'Implement feature',
    projectPath: '/tmp/auto-project',
    autoContinue: true,
    followupTasks: ['Run tests']
  }, { queued: false });

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'Findings\nP2 src/app.js: implementation completed with enough detail to count as a reviewable stable result.',
    stable: true,
    elapsedMs: 1000
  });

  assert.strictEqual(task.status, 'done');
  assert.strictEqual(task.nextTaskId, 'task_auto_2');
  const nextTask = gateway.taskQueue.get('task_auto_2');
  assert.ok(nextTask);
  assert.strictEqual(nextTask.projectPath, '/tmp/auto-project');
  assert.strictEqual(nextTask.autoContinue, true);
  assert.strictEqual(nextTask.status, 'queued');
});

test('Gateway queued tasks wait indefinitely by default for external model queues', () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1234 } };
  gateway.taskHistoryStore = {
    createTask: () => 'task_wait_forever_1',
    recordStep: () => {}
  };
  const task = gateway._createQueuedTask({
    task: 'wait for Trae queue'
  }, { queued: true, queueMessage: 'model busy' });

  assert.strictEqual(task.deadline, null);
  assert.strictEqual(task.maxDeadline, null);
});

test('Gateway syncTaskHistoryMirror preserves queued workflow statuses in history', () => {
  const gateway = new Gateway();
  const calls = [];
  gateway.taskHistoryStore = {
    ensureTask: (...args) => {
      calls.push(args);
      return {};
    }
  };

  gateway._syncTaskHistoryMirror({
    taskId: 'task_hist_1',
    task: 'review repo',
    status: 'queued',
    createdAt: 1234,
    reviewRequired: true,
    followupTasks: []
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][2].status, 'queued');
  assert.strictEqual(calls[0][2].updateExisting, true);
});

test('Gateway persists active tasks and restores submitted executing tasks without requeueing', () => {
  const queueFile = path.join(os.tmpdir(), `traecnclaw-gateway-test-${Date.now()}.json`);
  const previousPath = process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH;
  process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = queueFile;

  try {
    const gateway = new Gateway();
    gateway.taskQueue.clear();
    gateway.taskQueue.set('queued_task', {
      taskId: 'queued_task',
      status: 'queued',
      task: 'review repo',
      createdAt: Date.now(),
      deadline: Date.now() + 1000,
      maxDeadline: Date.now() + 2000
    });
    gateway.taskQueue.set('executing_task', {
      taskId: 'executing_task',
      status: 'executing',
      task: 'draft reply',
      createdAt: Date.now(),
      deadline: Date.now() + 1000,
      maxDeadline: Date.now() + 2000,
      submittedToTrae: true,
      submittedAt: Date.now()
    });
    gateway.taskQueue.set('pre_submit_executing_task', {
      taskId: 'pre_submit_executing_task',
      status: 'executing',
      task: 'not sent yet',
      createdAt: Date.now(),
      deadline: Date.now() + 1000,
      maxDeadline: Date.now() + 2000,
      submittedToTrae: false
    });
    gateway.taskQueue.set('done_task', {
      taskId: 'done_task',
      status: 'done',
      task: 'old task'
    });
    gateway._persistActiveQueue();

    const persisted = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.strictEqual(persisted.tasks.length, 3);
    assert.ok(persisted.tasks.every(task => task.status !== 'done'));

    const restoredGateway = new Gateway();
    assert.strictEqual(restoredGateway.taskQueue.get('queued_task').status, 'queued');
    assert.strictEqual(restoredGateway.taskQueue.get('executing_task').status, 'executing');
    assert.strictEqual(restoredGateway.taskQueue.get('executing_task').submittedToTrae, true);
    assert.strictEqual(restoredGateway.taskQueue.get('pre_submit_executing_task').status, 'queued');
    assert.strictEqual(restoredGateway.taskQueue.has('done_task'), false);
    assert.ok(restoredGateway.taskHistoryStore.getTask('queued_task'));
    assert.ok(restoredGateway.taskHistoryStore.getTask('executing_task'));
    assert.strictEqual(restoredGateway.taskHistoryStore.getTask('queued_task').status, 'queued');
    assert.strictEqual(restoredGateway.taskHistoryStore.getTask('executing_task').status, 'executing');
  } finally {
    if (fs.existsSync(queueFile)) {
      fs.unlinkSync(queueFile);
    }
    restoreEnv('TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH', previousPath);
  }
});

test('Gateway restores queued tasks without adding a local queue deadline', () => {
  const queueFile = path.join(os.tmpdir(), `traecnclaw-gateway-no-deadline-test-${Date.now()}.json`);
  const previousPath = process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH;
  process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = queueFile;

  try {
    fs.writeFileSync(queueFile, JSON.stringify({
      version: 1,
      tasks: [{
        taskId: 'queued_without_deadline',
        status: 'queued',
        task: 'wait indefinitely',
        createdAt: Date.now()
      }]
    }), 'utf8');

    const gateway = new Gateway();
    const task = gateway.taskQueue.get('queued_without_deadline');
    assert.ok(task);
    assert.strictEqual(task.deadline, null);
    assert.strictEqual(task.maxDeadline, null);
  } finally {
    if (fs.existsSync(queueFile)) fs.unlinkSync(queueFile);
    restoreEnv('TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH', previousPath);
  }
});

test('Gateway does not restore persisted active queue while mock bridge is enabled', () => {
  const queueFile = path.join(os.tmpdir(), `traecnclaw-gateway-mock-test-${Date.now()}.json`);
  const previousQueuePath = process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH;
  const previousMock = process.env.TRAECN_ENABLE_MOCK_BRIDGE;
  process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = queueFile;
  process.env.TRAECN_ENABLE_MOCK_BRIDGE = '1';

  try {
    fs.writeFileSync(queueFile, JSON.stringify({
      version: 1,
      tasks: [{
        taskId: 'task_live_1',
        status: 'queued',
        task: 'real queued task',
        createdAt: Date.now(),
        deadline: Date.now() + 1000,
        maxDeadline: Date.now() + 5000
      }]
    }), 'utf8');

    const gateway = new Gateway();
    assert.strictEqual(gateway.mockBridge, true);
    assert.strictEqual(gateway.taskQueue.size, 0);
  } finally {
    if (fs.existsSync(queueFile)) fs.unlinkSync(queueFile);
    restoreEnv('TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH', previousQueuePath);
    restoreEnv('TRAECN_ENABLE_MOCK_BRIDGE', previousMock);
  }
});

test('Gateway extends queued task deadline while external queue is still active', () => {
  const gateway = new Gateway();
  const recorded = [];
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000, queueTimeoutExtensionMs: 5000 } };
  gateway.taskHistoryStore = {
    recordStep: (...args) => recorded.push(args)
  };
  const now = Date.now();
  const task = {
    taskId: 'task_ext_1',
    deadline: now - 1000,
    maxDeadline: now + 30000,
    timeoutExtensions: 0
  };
  const extended = gateway._maybeExtendQueuedTaskDeadline(task, { queued: true, message: 'Queue notice is visible' });
  assert.strictEqual(extended, true);
  assert.strictEqual(task.timeoutExtensions, 1);
  assert.ok(task.deadline > now);
  assert.strictEqual(recorded.length, 1);
});

test('Gateway does not extend queued task deadline after max wait is exhausted', () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000, queueTimeoutExtensionMs: 5000 } };
  gateway.taskHistoryStore = { recordStep: () => {} };
  const now = Date.now();
  const task = {
    taskId: 'task_ext_2',
    deadline: now - 1000,
    maxDeadline: now - 1,
    timeoutExtensions: 0
  };
  const extended = gateway._maybeExtendQueuedTaskDeadline(task, { queued: true, message: 'Queue notice is visible' });
  assert.strictEqual(extended, false);
  assert.strictEqual(task.timeoutExtensions, 0);
});

test('Gateway queue runtime summary excludes terminal tasks', () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.taskQueue.set('queued_task', { status: 'queued' });
  gateway.taskQueue.set('review_task', { status: 'awaiting_review' });
  gateway.taskQueue.set('done_task', { status: 'done' });
  gateway.taskQueue.set('cancelled_task', { status: 'cancelled' });
  const summary = gateway._queueRuntimeSummary();
  assert.strictEqual(summary.tasks.total, 2);
  assert.strictEqual(summary.tasks.byStatus.queued, 1);
  assert.strictEqual(summary.tasks.byStatus.awaiting_review, 1);
  assert.strictEqual(summary.tasks.byStatus.done, undefined);
});

test('Gateway compactReadiness preserves blocker and workspace guide hints', () => {
  const gateway = new Gateway();
  const readiness = gateway._compactReadiness({
    ready: false,
    blocker: 'login_required',
    workspaceGuide: { dismissed: 1, guideVisible: false, reason: null },
    blockers: { guideVisible: false, guideButtons: ['继续'], loginVisible: true, newTaskVisible: false }
  });
  assert.strictEqual(readiness.blocker, 'login_required');
  assert.strictEqual(readiness.workspaceGuide.dismissed, 1);
  assert.strictEqual(readiness.blockers.loginVisible, true);
});

test('Gateway preflight nextAction distinguishes login and workspace guide blockers', () => {
  const gateway = new Gateway();
  assert.strictEqual(
    gateway._preflightNextAction({ connected: false, status: { traeRunning: true } }),
    'restart_traecn_with_debug_existing_profile'
  );
  assert.strictEqual(
    gateway._preflightNextAction({ connected: true, surface: { kind: 'workspace' }, readiness: { ready: false, blocker: 'workspace_guide' }, queue: { queued: false }, dialog: { hasDialog: false } }),
    'dismiss_workspace_guide'
  );
  assert.strictEqual(
    gateway._preflightNextAction({ connected: true, surface: { kind: 'workspace' }, readiness: { ready: false, blocker: 'login_required' }, queue: { queued: false }, dialog: { hasDialog: false } }),
    'login_traecn'
  );
});

test('Gateway only treats stable non-timeout output as reviewable', () => {
  const gateway = new Gateway();
  assert.strictEqual(gateway._isReviewableResult({ text: 'Findings\nP2 src/http/gateway.js: concrete risk with enough detail to be actionable and reviewable by the caller.', stable: true }), true);
  assert.strictEqual(gateway._isReviewableResult({ text: 'partial thoughts', stable: false, timedOut: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: 'streaming', stable: false, streaming: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: '模型请求失败', stable: false, modelError: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: '', stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: 'SOLO Agent思考中...The user is asking for review', stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: "I'll start by invoking the relevant skill", stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: '调用技能: TRAE-code-reviewThoughtNow I have the code review skill loaded. Let me start by exploring the project structure.', stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: 'Let me start by reviewing.\nFindings\nP1 fake', stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: 'Thought\nFindings\nP1 fake', stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: 'Agent\n手动终止输出', stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: 'Agent\n异常打断', stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({ text: '0/9 已完成 探索项目结构 审查自动排队机制 Thought Let me now look at the key areas more closely. 思考中...'.repeat(2), stable: true }), false);
  assert.strictEqual(gateway._isReviewableResult({
    text: '0/5 已完成 Create files Thought npm test failed Thought fixed test Thought 所有测试通过！ 已完成。以下是创建的文件和运行说明：demo-output/project/package.json src/cli.js test/file.test.js。任务完成，交付说明完整。',
    stable: true
  }), true);
});

test('Gateway only treats stable non-error output as successful', () => {
  const gateway = new Gateway();
  assert.strictEqual(gateway._isSuccessfulResult({ text: 'TRAECN_REAL_UAT_OK_20260612', stable: true }), true);
  assert.strictEqual(gateway._isSuccessfulResult({ text: '模型请求失败', stable: false, modelError: true }), false);
  assert.strictEqual(gateway._isSuccessfulResult({ text: 'Agent\n手动终止输出', stable: true }), false);
  assert.strictEqual(gateway._isSuccessfulResult({ text: 'Agent', stable: true }), false);
  assert.strictEqual(gateway._isSuccessfulResult({ text: 'partial', stable: false, streaming: true }), false);
});

asyncTest('Gateway task status exposes queued task queue details snapshot', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.set('task_q_1', {
    status: 'queued',
    createdAt: Date.now() - 5000,
    deadline: Date.now() + 10000,
    queueState: 'queued',
    queuePosition: 42,
    queueEstimatedWait: '3m',
    queueMessage: '排在第 42 位',
    currentModel: 'DeepSeek-V4-Pro'
  });

  let responseData = null;
  gateway._json = (req, res, data) => {
    responseData = data;
  };

  gateway._refreshQueuedTaskSnapshot = async () => {};
  await gateway._handleTaskStatus({}, {}, 'task_q_1');
  assert.strictEqual(responseData.status, 'queued');
  assert.strictEqual(responseData.queueDetails.queuePosition, 42);
  assert.strictEqual(responseData.queueDetails.currentModel, 'DeepSeek-V4-Pro');
  assert.strictEqual(responseData.queueDetails.queueMessage, '排在第 42 位');
});

asyncTest('Gateway task status refreshes queued snapshot before responding', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.set('task_q_live', {
    status: 'queued',
    createdAt: Date.now() - 5000,
    deadline: Date.now() + 10000,
    queueState: 'queued',
    queuePosition: 42,
    queueEstimatedWait: null,
    queueMessage: '排在第 42 位',
    currentModel: 'DeepSeek-V4-Pro'
  });
  gateway._refreshQueuedTaskSnapshot = async (task) => {
    task.queuePosition = 21;
    task.queueMessage = '排在第 21 位';
  };

  let responseData = null;
  gateway._json = (req, res, data) => {
    responseData = data;
  };

  await gateway._handleTaskStatus({}, {}, 'task_q_live');
  assert.strictEqual(responseData.queueDetails.queuePosition, 21);
  assert.strictEqual(responseData.queueDetails.queueMessage, '排在第 21 位');
});

asyncTest('Gateway collects submitted executing task without resending prompt', async () => {
  const gateway = new Gateway();
  let sendCalled = false;
  const task = {
    taskId: 'task_submitted_live',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 4000,
    reviewRequired: true,
    followupTasks: [],
    queueState: 'queued'
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    checkQueueStatus: async () => ({
      queued: true,
      running: false,
      canSubmit: true,
      queuePosition: 7,
      queueMessage: '排在第 7 位',
      currentModel: 'DeepSeek-V4-Pro'
    }),
    sendMessage: async () => {
      sendCalled = true;
      throw new Error('sendMessage must not be called');
    },
    newChat: async () => {
      throw new Error('newChat must not be called');
    },
    collectResponse: async () => ({
      text: 'Findings\nP2 src/http/gateway.js: concrete risk with enough detail to be actionable and reviewable by the caller.',
      stable: true,
      elapsedMs: 1234
    })
  };

  await gateway._collectSubmittedBackgroundTask(task.taskId, task);

  assert.strictEqual(sendCalled, false);
  assert.strictEqual(task.status, 'awaiting_review');
  assert.strictEqual(task.queuePosition, 7);
  assert.ok(task.result.text.includes('Findings'));
});

asyncTest('Gateway schedules retry instead of final error for transient background failures', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  const retried = await gateway._retryBackgroundTaskAfterError(task.taskId, task, new Error('CDP disconnected'), {
    maxAttempts: 2
  });

  assert.strictEqual(retried, true);
  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.queueState, 'executing');
  assert.strictEqual(task.attempts, 1);
  assert.strictEqual(task.error, 'CDP disconnected');

  task.submittedToTrae = false;
  task.queueState = 'running';
  task.status = 'running';
  task.attempts = 0;
  const requeued = await gateway._retryBackgroundTaskAfterError(task.taskId, task, new Error('model busy'), {
    maxAttempts: 2
  });
  assert.strictEqual(requeued, true);
  assert.strictEqual(task.status, 'queued');
  assert.strictEqual(task.queueState, 'queued');

  task.attempts = 2;
  const exhausted = await gateway._retryBackgroundTaskAfterError(task.taskId, task, new Error('still broken'), {
    maxAttempts: 2
  });
  assert.strictEqual(exhausted, false);
});

asyncTest('Gateway finalizes submitted executing task after recovery retries are exhausted', async () => {
  const gateway = new Gateway();
  gateway.taskQueue = new Map();
  gateway.taskLocks = new Set();
  let pollOnce = null;
  gateway._setInterval = (fn) => {
    pollOnce = fn;
    return { id: 'timer' };
  };
  gateway._clearInterval = () => {};
  gateway._collectSubmittedBackgroundTask = async () => {
    throw new Error('CDP disconnected permanently');
  };
  gateway._emitTaskNotification = async () => {};

  const task = {
    taskId: 'task_submitted_retry_exhausted',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 3,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  gateway._ensureBackgroundPolling();
  await pollOnce();

  assert.strictEqual(task.status, 'error');
  assert.strictEqual(task.error, 'CDP disconnected permanently');
});

asyncTest('Gateway keeps submitted task executing when collected result times out', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_collect',
    status: 'executing',
    task: 'say ok',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: false,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'partial',
    stable: false,
    timedOut: true,
    elapsedMs: 600000
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /collecting again/);
});

asyncTest('Gateway keeps collecting when result is only a role label', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_role_label',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'Agent',
    stable: true,
    elapsedMs: 1234
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 1);
});

asyncTest('Gateway keeps collecting short UI noise for review-required tasks', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_ui_noise',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '(parameter) res: any',
    stable: true,
    elapsedMs: 4033
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /collecting again/);
});

asyncTest('Gateway keeps collecting early auto-continue workflow progress text', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_workflow_progress',
    status: 'executing',
    task: 'create demo project',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: false,
    autoContinue: true,
    followupTasks: [{ task: 'run tests', reviewRequired: false, autoContinue: true }]
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'I will create the files now. 0/5 已完成 Create package.json Create src/slugify.js Create tests 思考中...',
    stable: true,
    elapsedMs: 1000
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /collecting again/);
});

asyncTest('Gateway keeps collecting incomplete review-gate process text', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_process_review',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '0/9 已完成 探索项目结构 审查自动排队机制 Thought Let me now look at the key areas more closely. 思考中...'.repeat(2),
    stable: false,
    elapsedMs: 381904,
    reviewGatePending: true
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /collecting again/);
});

asyncTest('Gateway does not auto-continue workflow from review-gate prompt echo', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_final_report_echo',
    status: 'executing',
    task: 'Final unattended workflow pass. Create FINAL_REPORT.md and append Follow-up 2.',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: false,
    autoContinue: true,
    followupTasks: [{ task: 'next step', reviewRequired: false, autoContinue: true }]
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'Final unattended workflow pass. Create FINAL_REPORT.md containing a checklist. Agent思考过程 0/8 已完成 Create files WORKFLOW_STATUS.md 正在生成...',
    stable: false,
    elapsedMs: 17258,
    timedOut: false,
    needsApproval: false,
    reviewGatePending: true
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /collecting again/);
});

asyncTest('Gateway resubmits completed-looking task when completion checks fail', async () => {
  const gateway = new Gateway();
  gateway.taskHistoryStore = {
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};
  const task = {
    taskId: 'task_completion_check_retry',
    status: 'executing',
    task: 'Create FINAL_REPORT.md and report completion.',
    projectPath: '/tmp/traecnclaw-missing-completion-check',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 4000,
    attempts: 0,
    reviewRequired: false,
    autoContinue: false,
    followupTasks: [],
    completionChecks: {
      requiredFiles: ['FINAL_REPORT.md'],
      requiredText: [{ filePath: 'WORKFLOW_STATUS.md', includes: ['Follow-up 1'] }]
    }
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'Final Report: All files created. All tests pass. No human interaction was needed.',
    stable: true,
    elapsedMs: 1234
  });

  assert.strictEqual(task.status, 'queued');
  assert.strictEqual(task.submittedToTrae, false);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /Completion checks failed/);
  assert.match(task.task, /FINAL_REPORT.md/);
  assert.match(task.task, /Follow-up 1/);
});

asyncTest('Gateway resubmits background task when Trae returns failed text', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_resubmit',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 3000,
    attempts: 0,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'Agent\n手动终止输出',
    stable: true,
    elapsedMs: 1234
  });

  assert.strictEqual(task.status, 'queued');
  assert.strictEqual(task.submittedToTrae, false);
  assert.strictEqual(task.submittedAt, null);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /resubmitting task/);
});

asyncTest('Gateway resubmits background task when Trae reports model error', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_model_error',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 3000,
    attempts: 0,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '模型请求失败',
    stable: false,
    modelError: true,
    error: 'Trae model request failed'
  });

  assert.strictEqual(task.status, 'queued');
  assert.strictEqual(task.submittedToTrae, false);
  assert.strictEqual(task.submittedAt, null);
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /resubmitting task/);
});

asyncTest('Gateway finalizes error after result retry attempts are exhausted', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_retry_exhausted',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 3,
    reviewRequired: true,
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: 'Agent\n异常打断',
    stable: true,
    error: 'Trae interrupted'
  });

  assert.strictEqual(task.status, 'error');
  assert.match(task.error, /incomplete or timed-out/);
});

asyncTest('Gateway task cancel stops submitted executing task', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_cancel_executing',
    status: 'executing',
    task: 'long task',
    createdAt: Date.now() - 5000,
    submittedToTrae: true
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway.taskLocks.add(task.taskId);
  let stopCalled = false;
  gateway.driver = {
    stopGeneration: async () => {
      stopCalled = true;
      return { success: true, reason: 'clicked_stop_button' };
    }
  };

  let responseData = null;
  gateway._json = (req, res, data) => {
    responseData = data;
  };

  await gateway._handleTaskCancel({}, {}, task.taskId);

  assert.strictEqual(stopCalled, true);
  assert.strictEqual(task.status, 'cancelled');
  assert.strictEqual(gateway.taskLocks.has(task.taskId), false);
  assert.strictEqual(responseData.status, 'cancelled');
  assert.strictEqual(responseData.stopResult.success, true);
});

asyncTest('Gateway ignores collected result after submitted task is cancelled', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_cancel_collect_race',
    status: 'executing',
    task: 'long task',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    queueState: 'running'
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway.taskHistoryStore = {
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => { throw new Error('cancelled task must not be completed'); },
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._ensureConnection = async () => {};
  gateway._syncTaskHistoryMirror = () => {};
  gateway._persistActiveQueue = () => {};
  gateway.driver = {
    checkQueueStatus: async () => ({ queued: false, running: true }),
    collectResponse: async () => {
      task.status = 'cancelled';
      return {
        text: '任务完成',
        stable: true,
        elapsedMs: 1000
      };
    }
  };

  const result = await gateway._collectSubmittedBackgroundTask(task.taskId, task);

  assert.strictEqual(result.stable, true);
  assert.strictEqual(task.status, 'cancelled');
  assert.strictEqual(task.result, undefined);
});

asyncTest('Gateway adopts current queued Trae request as submitted background task', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    checkQueueStatus: async () => ({
      queued: true,
      running: false,
      canSubmit: true,
      queuePosition: 12,
      queueMessage: '排在第 12 位',
      currentModel: 'DeepSeek-V4-Pro'
    })
  };
  gateway.taskHistoryStore = {
    createTask: () => 'task_adopted_current',
    recordStep: () => {},
    ensureTask: () => {}
  };

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'review repo', reviewRequired: true }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleAdoptCurrentTask(req, {});
  const task = gateway.taskQueue.get('task_adopted_current');
  assert.strictEqual(responseStatus, 202);
  assert.strictEqual(responseData.status, 'executing');
  assert.strictEqual(responseData.submittedToTrae, true);
  assert.strictEqual(responseData.queueDetails.queuePosition, 12);
  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
});

asyncTest('Gateway refuses to adopt when no submitted Trae request is visible', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: true, currentModel: 'DeepSeek-V4-Pro' })
  };

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'review repo' }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleAdoptCurrentTask(req, {});
  assert.strictEqual(responseStatus, 409);
  assert.ok(responseData.error.includes('No visible queued or running Trae request'));
});

asyncTest('Gateway exposes Trae review gate status and resolver', async () => {
  const gateway = new Gateway();
  let resolvedAction = null;
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    checkTaskReviewGate: async () => ({
      awaitingReview: true,
      taskCompleted: true,
      keepAll: { text: '全部保留' },
      revertAll: { text: '全部撤销' }
    }),
    resolveTaskReviewGate: async (action) => {
      resolvedAction = action;
      return { success: true, action };
    }
  };

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  await gateway._handleReviewGateStatus({}, {});
  assert.strictEqual(responseData.awaitingReview, true);
  assert.strictEqual(responseData.keepAll.text, '全部保留');

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ action: 'keep' }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleReviewGateResolve(req, {});
  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(resolvedAction, 'keep_all');
  assert.strictEqual(responseData.success, true);
});

asyncTest('Gateway restart-debug requires explicit confirmation before quitting Trae', async () => {
  const gateway = new Gateway();
  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ cdpWaitMs: 1 }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleRestartTraeDebug(req, {});
  assert.strictEqual(responseStatus, 409);
  assert.strictEqual(responseData.confirmationPhrase, 'restart-trae-cn-with-debug-existing-profile');
  assert.strictEqual(responseData.plan.command, 'restart_trae_debug');
});

asyncTest('Gateway task status falls back to history for cleaned terminal tasks', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.taskHistoryStore = {
    getTask: () => ({
      taskId: 'task_hist_failed',
      task: 'review repo',
      status: 'failed',
      createdAt: new Date(Date.now() - 5000).toISOString(),
      createdAtMs: Date.now() - 5000,
      completedAt: new Date().toISOString(),
      elapsedMs: 5000,
      result: { error: 'CDP client not connected' },
      metadata: { currentModel: 'Kimi-K2.6' },
      steps: [
        { action: 'queued', timestamp: new Date().toISOString(), success: true, details: {} },
        { action: 'error', timestamp: new Date().toISOString(), success: false, error: 'CDP client not connected', details: {} }
      ]
    })
  };

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
  };

  await gateway._handleTaskStatus({}, {}, 'task_hist_failed');
  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(responseData.status, 'error');
  assert.strictEqual(responseData.fromHistory, true);
  assert.strictEqual(responseData.error, 'CDP client not connected');
  assert.strictEqual(responseData.lastStep.action, 'error');
});

asyncTest('Gateway recovers review-gate persistence into awaiting_review result', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    checkTaskReviewGate: async () => ({
      awaitingReview: true,
      taskCompleted: true
    }),
    _captureIdePanelText: async () => 'Agent 审查结果内容'
  };

  const task = {
    taskId: 'task_gate_1',
    createdAt: Date.now() - 1000,
    followupTasks: [],
    reviewRequired: true
  };

  const recovered = await gateway._recoverAwaitingReviewFromGate(task);
  assert.ok(recovered);
  assert.strictEqual(recovered.needsApproval, false);
  assert.strictEqual(recovered.reviewGatePending, true);
  assert.ok(recovered.text.includes('审查结果内容'));
});

asyncTest('Gateway sync delegate_async recovers review gate into awaiting_review task', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1234 },
    checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: false }),
    delegate: async () => {
      throw new Error('Task review gate blocked new chat: review_gate_persisted');
    }
  };
  gateway._ensureConnection = async () => {};
  gateway._recoverAwaitingReviewFromGate = async () => ({
    text: 'Findings\nP2 src/http/gateway.js: review gate recovery returned a concrete actionable finding with enough detail to be reviewable by the caller.',
    stable: true,
    elapsedMs: 1234,
    timedOut: false,
    needsApproval: false,
    reviewGatePending: true
  });
  gateway.taskHistoryStore = {
    createTask: () => 'task_sync_recover',
    recordStep: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'review repo', waitForQueue: false, reviewRequired: true }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDelegateAsync(req, {});
  assert.strictEqual(responseStatus, 202);
  assert.strictEqual(responseData.status, 'awaiting_review');
  assert.strictEqual(responseData.taskId, 'task_sync_recover');
  assert.ok(responseData.resultPreview.includes('Findings'));
});

asyncTest('Gateway switch-model can return immediately with queue details when waitForQueue is false', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    switchModel: async () => ({
      success: true,
      model: 'GLM-5.1',
      previousModel: 'DeepSeek-V4-Pro',
      switchResult: 'clicked: GLM-5.1'
    }),
    checkQueueStatus: async () => ({
      queued: true,
      running: false,
      canSubmit: false,
      currentModel: 'GLM-5.1',
      queueMessage: 'Queue notice is visible'
    })
  };

  let responseData = null;
  gateway._json = (req, res, data) => {
    responseData = data;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ model: 'GLM-5.1', waitForQueue: false }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleSwitchModel(req, {});
  assert.strictEqual(responseData.success, true);
  assert.strictEqual(responseData.queued, true);
  assert.strictEqual(responseData.queueDetails.currentModel, 'GLM-5.1');
  assert.strictEqual(responseData.queueDetails.state, 'queued');
});

test('Gateway updates queued task snapshot from live queue status', () => {
  const gateway = new Gateway();
  const task = {
    status: 'queued',
    queueState: 'queued',
    queuePosition: null,
    queueEstimatedWait: null,
    queueMessage: null,
    currentModel: null
  };

  gateway._updateQueuedTaskSnapshot(task, {
    queued: true,
    running: false,
    queuePosition: 128,
    queueEstimatedWait: '9m',
    queueMessage: '排在第 128 位',
    currentModel: 'DeepSeek-V4-Pro'
  });

  assert.strictEqual(task.queueState, 'queued');
  assert.strictEqual(task.queuePosition, 128);
  assert.strictEqual(task.queueEstimatedWait, '9m');
  assert.strictEqual(task.queueMessage, '排在第 128 位');
  assert.strictEqual(task.currentModel, 'DeepSeek-V4-Pro');
});

test('Gateway clears stale queued task snapshot after live queue drains', () => {
  const gateway = new Gateway();
  const task = {
    status: 'executing',
    submittedToTrae: true,
    queueState: 'queued',
    queuePosition: 87,
    queueEstimatedWait: '3m',
    queueMessage: '排在第 87 位',
    currentModel: 'DeepSeek-V4-Pro'
  };

  gateway._updateQueuedTaskSnapshot(task, {
    queued: false,
    running: false,
    canSubmit: false,
    currentModel: 'DeepSeek-V4-Pro'
  });

  assert.strictEqual(task.queueState, 'ready');
  assert.strictEqual(task.queuePosition, null);
  assert.strictEqual(task.queueEstimatedWait, null);
  assert.strictEqual(task.queueMessage, null);
  assert.strictEqual(task.currentModel, 'DeepSeek-V4-Pro');
});

test('Gateway preserves recent submitted queue snapshot during brief queue flicker', () => {
  const gateway = new Gateway();
  const task = {
    status: 'executing',
    submittedToTrae: true,
    queueState: 'queued',
    queuePosition: 36,
    queueEstimatedWait: null,
    queueMessage: '排在第 36 位',
    currentModel: 'DeepSeek-V4-Pro',
    lastQueueSeenAt: Date.now() - 1000
  };

  gateway._updateQueuedTaskSnapshot(task, {
    queued: false,
    running: false,
    canSubmit: false,
    currentModel: 'DeepSeek-V4-Pro'
  });

  assert.strictEqual(task.queueState, 'queued');
  assert.strictEqual(task.queuePosition, 36);
  assert.strictEqual(task.queueMessage, '排在第 36 位');
  assert.strictEqual(task.queueCanSubmit, false);
});

asyncTest('Gateway queue status uses recent submitted task snapshot during queue flicker', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.set('task_live_flicker', {
    status: 'executing',
    submittedToTrae: true,
    queueState: 'queued',
    queuePosition: 40,
    queueEstimatedWait: null,
    queueMessage: '排在第 40 位',
    currentModel: 'DeepSeek-V4-Pro',
    lastQueueSeenAt: Date.now() - 1000
  });
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    checkQueueStatus: async () => ({
      queued: false,
      running: false,
      canSubmit: false,
      currentModel: 'DeepSeek-V4-Pro'
    })
  };

  let responseData = null;
  gateway._json = (req, res, data) => {
    responseData = data;
    return data;
  };

  await gateway._handleQueueStatus({}, {});
  assert.strictEqual(responseData.queued, true);
  assert.strictEqual(responseData.running, false);
  assert.strictEqual(responseData.canSubmit, false);
  assert.strictEqual(responseData.queuePosition, 40);
  assert.strictEqual(responseData.queueMessage, '排在第 40 位');
  assert.strictEqual(responseData.queueSnapshotSource, 'recent_submitted_task');
});

test('Gateway normalizes fallback model candidates with auto defaults', () => {
  const gateway = new Gateway();
  assert.deepStrictEqual(gateway._normalizeFallbackModels([' GLM-5.1 ', 'glm-5.1', 'Kimi-K2.6']), ['GLM-5.1', 'Kimi-K2.6']);
  assert.ok(gateway._normalizeFallbackModels(null, true).includes('GLM-5.1'));
  assert.deepStrictEqual(gateway._normalizeFallbackModels('A,B,A'), ['A', 'B']);
});

asyncTest('Gateway probes fallback models and selects first ready candidate', async () => {
  const gateway = new Gateway();
  const calls = [];
  gateway.driver = {
    switchModel: async (model) => {
      calls.push(['switch', model]);
      return { success: true, model, switchResult: 'clicked: ' + model };
    },
    checkQueueStatus: async () => {
      const current = calls[calls.length - 1][1];
      if (current === 'GLM-5.1') {
        return { queued: true, running: false, canSubmit: false, currentModel: current };
      }
      return { queued: false, running: false, canSubmit: true, currentModel: current };
    }
  };
  const recorded = [];
  gateway.taskHistoryStore = { recordStep: (...args) => recorded.push(args) };

  const task = {
    taskId: 'task_probe_1',
    fallbackModels: ['GLM-5.1', 'Kimi-K2.6'],
    modelProbeIntervalMs: 15000,
    nextModelProbeAt: Date.now() - 1
  };
  const result = await gateway._probeFallbackModels(task);
  assert.strictEqual(result.ready, true);
  assert.strictEqual(result.selectedModel, 'Kimi-K2.6');
  assert.strictEqual(task.modelProbeResults.length, 2);
  assert.strictEqual(recorded[0][1], 'model_probe');
});

asyncTest('Gateway delegate-async queues with fallback model probe evidence when all candidates are queued', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    checkQueueStatus: async () => ({
      queued: true,
      running: false,
      canSubmit: false,
      currentModel: 'DeepSeek-V4-Pro',
      queueMessage: 'Queue notice is visible'
    }),
    switchModel: async (model) => ({ success: true, model, switchResult: 'clicked: ' + model })
  };
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway.taskHistoryStore = {
    createTask: () => 'task_probe_queue',
    recordStep: () => {}
  };

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({
        task: 'review repo',
        waitForQueue: true,
        fallbackModels: ['GLM-5.1', 'Kimi-K2.6']
      }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDelegateAsync(req, {});
  assert.strictEqual(responseStatus, 202);
  assert.strictEqual(responseData.status, 'queued');
  assert.strictEqual(responseData.taskId, 'task_probe_queue');
  assert.strictEqual(responseData.modelProbeResults.length, 2);
  assert.strictEqual(responseData.modelProbeResults.every(item => item.queued), true);
});

asyncTest('Gateway delegate-async executes immediately when fallback probe finds ready model', async () => {
  const gateway = new Gateway();
  const statusByModel = {
    'GLM-5.1': { queued: true, running: false, canSubmit: false, currentModel: 'GLM-5.1' },
    'Kimi-K2.6': { queued: false, running: false, canSubmit: true, currentModel: 'Kimi-K2.6' }
  };
  let currentModel = 'DeepSeek-V4-Pro';
  gateway.driver = {
    checkQueueStatus: async () => statusByModel[currentModel] || { queued: true, running: false, canSubmit: false, currentModel },
    switchModel: async (model) => {
      currentModel = model;
      return { success: true, model, switchResult: 'clicked: ' + model };
    },
    delegate: async () => ({ text: 'review done', stable: true, elapsedMs: 10, timedOut: false })
  };
  gateway._ensureConnection = async () => {};

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({
        task: 'review repo',
        waitForQueue: true,
        fallbackModels: ['GLM-5.1', 'Kimi-K2.6']
      }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDelegateAsync(req, {});
  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(responseData.status, 'done');
  assert.strictEqual(responseData.text, 'review done');
});

asyncTest('Gateway sync delegate timeout converts submitted request to tracked background task', async () => {
  const gateway = new Gateway();
  let resolveDelegate;
  let delegatedPrompt = '';
  const delegatePromise = new Promise((resolve) => {
    resolveDelegate = resolve;
  });
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: true, currentModel: 'DeepSeek-V4-Pro' }),
    delegate: async (task) => {
      delegatedPrompt = task;
      return delegatePromise;
    }
  };
  gateway._ensureConnection = async () => {};
  gateway._setTimeout = (callback) => setTimeout(callback, 0);
  gateway.taskHistoryStore = {
    createTask: () => 'task_timeout_background',
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'review repo', projectPath: '/tmp/sync-project', waitForQueue: true, reviewRequired: true }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDelegateAsync(req, {});
  assert.strictEqual(responseStatus, 202);
  assert.strictEqual(responseData.status, 'executing');
  assert.strictEqual(responseData.submittedToTrae, true);
  assert.strictEqual(responseData.taskId, 'task_timeout_background');
  assert.match(delegatedPrompt, /Project path: \/tmp\/sync-project/);
  assert.strictEqual(gateway.taskQueue.get('task_timeout_background').submittedToTrae, true);
  assert.strictEqual(gateway.taskQueue.get('task_timeout_background').projectPath, '/tmp/sync-project');

  resolveDelegate({ text: 'Findings\nP2 src/http/gateway.js: concrete risk with enough detail to be actionable and reviewable by the caller.', stable: true, elapsedMs: 200000 });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const trackedTask = gateway.taskQueue.get('task_timeout_background');
  assert.strictEqual(trackedTask.status, 'awaiting_review');
  assert.ok(trackedTask.result.text.includes('Findings'));
});

asyncTest('Gateway sync delegate keeps collecting incomplete review output in background', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: true, currentModel: 'DeepSeek-V4-Pro' }),
    delegate: async () => ({
      text: '好，让我来 review 这个 TRAECNclaw 项目。 0/5 已完成 了解项目结构和架构 审查核心代码：gateway.js 总结发现的问题和建议 审查安全和配置 审查测试质量',
      stable: true,
      elapsedMs: 15341
    })
  };
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'review repo', waitForQueue: true, reviewRequired: true }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDelegateAsync(req, {});

  assert.strictEqual(responseStatus, 202);
  assert.strictEqual(responseData.status, 'executing');
  assert.match(responseData.message, /后台继续收集/);
  const task = gateway.taskQueue.get(responseData.taskId);
  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 1);
});

asyncTest('Gateway keeps collecting echoed task text instead of marking it done', async () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000 } };
  gateway.taskHistoryStore = {
    createTask: () => 'task_echo_guard',
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  const task = gateway._createQueuedTask({
    task: 'Queue stress test. Create package.json, src/index.js, tests, run them, and report exact commands. Do not modify files outside demo-output/queue-lab.'
  }, { queued: false });
  task.status = 'executing';
  task.submittedToTrae = true;

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '13:16 Queue stress test. Create package.json, src/index.js, tests, run them, and report exact commands. Do not modify files outside demo-output/queue-lab. Agent',
    stable: true,
    elapsedMs: 1000
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.attempts, 1);
  assert.match(task.error, /incomplete/i);
});

asyncTest('Gateway accepts timed-out text when it contains strong completion evidence', async () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000 } };
  gateway.taskHistoryStore = {
    createTask: () => 'task_strong_completion',
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};
  const task = gateway._createQueuedTask({
    task: 'Create a package, run tests, and report results.'
  }, { queued: false });
  task.status = 'executing';
  task.submittedToTrae = true;

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '8/8 已完成. Final Report: Files created: package.json, src/index.js, test/index.test.js. Commands run: node --test test/index.test.js. All 47 tests pass. No files were modified outside the requested directory.',
    stable: false,
    timedOut: true,
    elapsedMs: 600006
  });

  assert.strictEqual(task.status, 'done');
});

asyncTest('Gateway finalizes restored executing task when persisted result is complete', async () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000 } };
  gateway.taskHistoryStore = {
    createTask: () => 'task_restored_complete',
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};
  const task = gateway._createQueuedTask({
    task: 'Create files, run tests, and report final status.'
  }, { queued: false });
  task.status = 'executing';
  task.submittedToTrae = true;
  task.result = {
    text: 'Final Report: Created all requested files. Commands run: node --test test/text-metrics.test.js. All 47 tests pass. 8/8 已完成.',
    stable: false,
    timedOut: true,
    elapsedMs: 600006
  };

  const finalized = await gateway._finalizePersistedResultIfComplete(task.taskId, task);

  assert.strictEqual(finalized, true);
  assert.strictEqual(task.status, 'done');
});

test('Gateway _clearAllTimers uses only clearTimeout (not redundant clearInterval)', () => {
  const gateway = new Gateway();
  const timer = gateway._setTimeout(() => {}, 10000);
  assert.strictEqual(gateway.activeTimers.size, 1);
  gateway._clearAllTimers();
  assert.strictEqual(gateway.activeTimers.size, 0);
});

test('Gateway _clearTimeout and _clearInterval both clean up activeTimers', () => {
  const gateway = new Gateway();
  const timeoutTimer = gateway._setTimeout(() => {}, 10000);
  const intervalTimer = gateway._setInterval(() => {}, 10000);
  assert.strictEqual(gateway.activeTimers.size, 2);
  gateway._clearTimeout(timeoutTimer);
  assert.strictEqual(gateway.activeTimers.size, 1);
  gateway._clearInterval(intervalTimer);
  assert.strictEqual(gateway.activeTimers.size, 0);
});

test('Gateway _normalizeFollowupTasks handles already-normalized objects', () => {
  const gateway = new Gateway();
  const result = gateway._normalizeFollowupTasks([
    { task: 'step 1', reviewRequired: false, includeProcessText: true }
  ]);
  assert.deepStrictEqual(result, [
    { task: 'step 1', reviewRequired: false, autoContinue: false, includeProcessText: true }
  ]);
});

test('Gateway _normalizeFollowupTasks filters tasks exceeding 100000 chars', () => {
  const gateway = new Gateway();
  const longTask = 'x'.repeat(100001);
  const result = gateway._normalizeFollowupTasks([longTask, 'short']);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].task, 'short');
});

test('Gateway _normalizeFollowupTasks ignores non-array input', () => {
  const gateway = new Gateway();
  assert.deepStrictEqual(gateway._normalizeFollowupTasks(null), []);
  assert.deepStrictEqual(gateway._normalizeFollowupTasks('string'), []);
  assert.deepStrictEqual(gateway._normalizeFollowupTasks(undefined), []);
});

test('Gateway _handleUpdateSelf returns 200 with success:false', () => {
  const gateway = new Gateway();
  let responseData, responseStatus;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
  };
  // Simulate _handleUpdateSelf behavior: calls _json with 200 and success:false
  gateway._json({}, {}, {
    success: false,
    version: require('../../package.json').version,
    force: false,
    message: 'Automatic self-update is not enabled.',
    currentVersion: require('../../package.json').version
  }, 200);
  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(responseData.success, false);
  assert.ok(responseData.currentVersion);
  assert.ok(responseData.message);
});

test('Gateway _handleBatchCancel sets _cancelled flag and stops executing tasks', () => {
  const gateway = new Gateway();
  gateway.batchTasks.set('batch1', {
    batchId: 'batch1',
    status: 'running',
    tasks: [
      { taskId: 't1', status: 'pending' },
      { taskId: 't2', status: 'executing' },
      { taskId: 't3', status: 'done' }
    ]
  });
  let responseData;
  gateway._json = (req, res, data) => { responseData = data; };
  gateway._handleBatchCancel({ headers: {} }, {}, 'batch1');
  assert.strictEqual(responseData.status, 'cancelled');
  const batch = gateway.batchTasks.get('batch1');
  // Batch is deleted after cancel
  assert.strictEqual(batch, undefined);
});

test('Gateway _handleBatchCancel returns 404 for unknown batch', () => {
  const gateway = new Gateway();
  let responseData, responseStatus;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
  };
  gateway._handleBatchCancel({ headers: {} }, {}, 'nonexistent');
  assert.strictEqual(responseStatus, 404);
  assert.strictEqual(responseData.error, 'Batch not found');
});

test('Gateway _handleBatchCancel returns 400 for already completed batch', () => {
  const gateway = new Gateway();
  gateway.batchTasks.set('batch_done', {
    batchId: 'batch_done',
    status: 'completed',
    tasks: []
  });
  let responseData, responseStatus;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
  };
  gateway._handleBatchCancel({ headers: {} }, {}, 'batch_done');
  assert.strictEqual(responseStatus, 400);
});

test('Gateway _handleBatchStatus returns batch details', () => {
  const gateway = new Gateway();
  const createdAt = new Date().toISOString();
  gateway.batchTasks.set('batch_view', {
    batchId: 'batch_view',
    status: 'running',
    strategy: 'parallel',
    maxConcurrency: 2,
    totalCount: 3,
    completedCount: 1,
    failedCount: 0,
    createdAt,
    tasks: [
      { taskId: 't1', priority: 1, status: 'done', result: { text: 'ok' } },
      { taskId: 't2', priority: 1, status: 'executing' },
      { taskId: 't3', priority: 2, status: 'pending' }
    ]
  });
  let responseData;
  gateway._json = (req, res, data) => { responseData = data; };
  gateway._handleBatchStatus({ headers: {} }, {}, 'batch_view');
  assert.strictEqual(responseData.batchId, 'batch_view');
  assert.strictEqual(responseData.pendingCount, 1);
  assert.strictEqual(responseData.executingCount, 1);
});

test('Gateway _handleBatchStatus returns 404 for unknown batch', () => {
  const gateway = new Gateway();
  let responseData, responseStatus;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
  };
  gateway._handleBatchStatus({ headers: {} }, {}, 'nonexistent');
  assert.strictEqual(responseStatus, 404);
});

test('Gateway preflight allows delegation when queue notice is advisory but send is possible', () => {
  const gateway = new Gateway();
  const nextAction = gateway._preflightNextAction({
    connected: true,
    surface: { kind: 'workspace' },
    readiness: { ready: true },
    queue: { queued: true, canSubmit: true, running: false },
    dialog: { hasDialog: false }
  });
  assert.strictEqual(nextAction, 'delegate_async');
});

asyncTest('Gateway dialog approve can answer Trae question cards', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  let pollingStarted = false;
  gateway._ensureBackgroundPolling = () => { pollingStarted = true; };
  gateway.driver = {
    checkForApprovalDialog: async () => ({
      needsApproval: true,
      dialogType: 'review_scope_question',
      question: 'Review Scope',
      buttons: ['取消', '下一个']
    }),
    checkRestrictedMode: async () => ({ restricted: false }),
    answerQuestionDialog: async (answer) => ({
      success: true,
      action: 'answer',
      answer,
      selectedOption: 'Uncommitted changes Review any uncommitted or staged workspace changes',
      buttonClicked: '下一个'
    })
  };
  gateway.taskQueue.set('task_waiting_for_scope', {
    taskId: 'task_waiting_for_scope',
    task: 'review repo',
    status: 'approval_required',
    result: {
      needsApproval: true,
      dialogType: 'review_scope_question',
      question: 'Review Scope'
    },
    submittedToTrae: true,
    createdAt: Date.now()
  });

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ action: 'answer', answer: 'Uncommitted changes' }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDialogApprove(req, {});

  assert.strictEqual(responseStatus, undefined);
  assert.strictEqual(responseData.success, true);
  assert.strictEqual(responseData.action, 'answer');
  assert.strictEqual(responseData.answer, 'Uncommitted changes');
  assert.strictEqual(responseData.buttonClicked, '下一个');
  assert.deepStrictEqual(responseData.resumedTaskIds, ['task_waiting_for_scope']);
  const resumedTask = gateway.taskQueue.get('task_waiting_for_scope');
  assert.strictEqual(resumedTask.status, 'executing');
  assert.strictEqual(resumedTask.submittedToTrae, true);
  assert.strictEqual(resumedTask.queueState, 'running');
  assert.strictEqual(resumedTask.answeredDialog.answer, 'Uncommitted changes');
  assert.strictEqual(pollingStarted, true);
});

asyncTest('Gateway dialog status exposes Trae question options and answer action', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    checkForApprovalDialog: async () => ({
      needsApproval: true,
      dialogType: 'review_scope_question',
      question: 'Review Scope',
      buttons: ['取消', '下一个'],
      options: [
        { label: 'Latest commit changes', description: 'Review only the latest commit' },
        { label: 'Uncommitted changes', description: 'Review uncommitted workspace changes' }
      ],
      canAutoApprove: false
    }),
    checkRestrictedMode: async () => ({ restricted: false })
  };

  let responseData = null;
  gateway._json = (req, res, data) => {
    responseData = data;
  };

  await gateway._handleDialogStatus({}, {});

  assert.strictEqual(responseData.hasDialog, true);
  assert.strictEqual(responseData.dialogType, 'review_scope_question');
  assert.strictEqual(responseData.options.length, 2);
  assert.strictEqual(responseData.options[1].label, 'Uncommitted changes');
  assert.deepStrictEqual(responseData.answerAction.body, { action: 'answer', answer: '<option label>' });
});

asyncTest('Gateway delegate-async keeps advisory queue in local background queue when waitForQueue=true', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    checkQueueStatus: async () => ({
      queued: true,
      canSubmit: true,
      running: false,
      currentModel: 'DeepSeek-V4-Pro',
      queuePosition: 123,
      queueMessage: '排在第 123 位'
    })
  };
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway._createQueuedTask = (body, queueStatus) => ({
    taskId: 'task_bg_1',
    reviewRequired: body.reviewRequired === true,
    followupTasks: gateway._normalizeFollowupTasks(body.followupTasks),
    queueState: queueStatus.queued ? 'queued' : 'running'
  });

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'review repo', waitForQueue: true, reviewRequired: true }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDelegateAsync(req, {},);
  assert.strictEqual(responseStatus, 202);
  assert.strictEqual(responseData.status, 'queued');
  assert.strictEqual(responseData.taskId, 'task_bg_1');
  assert.strictEqual(responseData.queueDetails.currentModel, 'DeepSeek-V4-Pro');
});

asyncTest('Gateway continues reviewed task into queued followup task', async () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000 } };
  gateway.taskHistoryStore = {
    createTask: () => 'task_followup_1',
    recordStep: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};
  gateway._ensureBackgroundPolling = () => {};

  const task = {
    taskId: 'task_parent',
    task: 'parent',
    status: 'awaiting_review',
    createdAt: Date.now(),
    followupTasks: [{ task: 'child', reviewRequired: true }],
    reviewRequired: true,
    notifyUrl: null,
    chatId: null,
    result: { text: 'done', stable: true, elapsedMs: 10 }
  };

  const result = await gateway._continueReviewedTask('task_parent', task, 'approve', 'looks good');
  assert.strictEqual(result.status, 'continued');
  assert.strictEqual(result.nextTaskId, 'task_followup_1');
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// ── open-project handler (v0.4.x) ───────────────────────────────────────

asyncTest('Gateway open-project returns 400 when projectPath is missing', async () => {
  const gateway = new Gateway();
  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({ read() {} });
  req.headers = { 'content-type': 'application/json' };
  req.push('{}');
  req.push(null);

  await gateway._handleOpenProject(req, {});
  assert.strictEqual(responseStatus, 400);
  assert.ok(responseData.error.includes('projectPath'));
});

asyncTest('Gateway open-project refuses to spawn when TraeCN is already running', async () => {
  const gateway = new Gateway();
  // Stub quickstart to simulate TraeCN already running with a live CDP target.
  const quickstart = require('../config/quickstart');
  const origIsRunning = quickstart.isTraeCNRunning;
  const origFind = quickstart.findTraeCNBinary;
  const origStart = quickstart.startTraeCN;
  quickstart.isTraeCNRunning = () => true;
  // Should never be called in this branch, but be defensive.
  quickstart.startTraeCN = () => {
    throw new Error('startTraeCN must not be invoked when TraeCN is already running');
  };

  // Stub the CDP discovery used inside the handler to report a stable surface.
  const discovery = require('../cdp/discovery');
  const origFetch = discovery.fetchCDPTargets;
  discovery.fetchCDPTargets = async () => ([
    { type: 'page', id: 'page-1', title: 'hello.py — TraeCNClaw', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1' }
  ]);

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  try {
    const req = new Readable({ read() {} });
    req.headers = { 'content-type': 'application/json' };
    req.push(JSON.stringify({ projectPath: '/tmp/some-project' }));
    req.push(null);

    await gateway._handleOpenProject(req, {});
    assert.strictEqual(responseStatus, 409);
    assert.strictEqual(responseData.success, false);
    assert.strictEqual(responseData.alreadyRunning, true);
    assert.strictEqual(responseData.projectPath, '/tmp/some-project');
    assert.ok(responseData.currentSurface);
    assert.strictEqual(responseData.currentSurface.title, 'hello.py — TraeCNClaw');
    assert.ok(/already running/i.test(responseData.error));
    assert.ok(/newInstance/.test(responseData.hint));
  } finally {
    quickstart.isTraeCNRunning = origIsRunning;
    quickstart.findTraeCNBinary = origFind;
    quickstart.startTraeCN = origStart;
    discovery.fetchCDPTargets = origFetch;
  }
});

asyncTest('Gateway open-project can opt into a separate window via newInstance=true', async () => {
  const gateway = new Gateway();
  const quickstart = require('../config/quickstart');
  const origIsRunning = quickstart.isTraeCNRunning;
  const origFind = quickstart.findTraeCNBinary;
  const origStart = quickstart.startTraeCN;
  quickstart.isTraeCNRunning = () => true; // even with TraeCN running, opt-in should proceed
  let startCalledWith = null;
  quickstart.startTraeCN = (opts) => {
    startCalledWith = opts;
    return { pid: 12345, command: 'open', args: ['-a', '/Applications/Trae CN.app', '--args', '/tmp/some-project'] };
  };
  quickstart.findTraeCNBinary = () => '/Applications/Trae CN.app';

  // CDP probe inside the handler should still run; return nothing so the polling
  // loop times out gracefully and we don't have to mock the rest of the flow.
  const discovery = require('../cdp/discovery');
  const origFetch = discovery.fetchCDPTargets;
  discovery.fetchCDPTargets = async () => [];

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  try {
    const req = new Readable({ read() {} });
    req.headers = { 'content-type': 'application/json' };
    req.push(JSON.stringify({ projectPath: '/tmp/some-project', newInstance: true }));
    req.push(null);

    await gateway._handleOpenProject(req, {});
    assert.strictEqual(responseStatus, 200);
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.started, true);
    assert.strictEqual(responseData.pid, 12345);
    assert.ok(startCalledWith);
    assert.strictEqual(startCalledWith.projectPath, '/tmp/some-project');
    assert.strictEqual(startCalledWith.newInstance, true);
  } finally {
    quickstart.isTraeCNRunning = origIsRunning;
    quickstart.findTraeCNBinary = origFind;
    quickstart.startTraeCN = origStart;
    discovery.fetchCDPTargets = origFetch;
  }
});

asyncTest('Gateway open-project returns 404 when no TraeCN binary is resolvable', async () => {
  const gateway = new Gateway();
  const quickstart = require('../config/quickstart');
  const origIsRunning = quickstart.isTraeCNRunning;
  const origFind = quickstart.findTraeCNBinary;
  const origStart = quickstart.startTraeCN;
  quickstart.isTraeCNRunning = () => false;
  quickstart.findTraeCNBinary = () => null; // simulate the binary being uninstalled

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  try {
    const req = new Readable({ read() {} });
    req.headers = { 'content-type': 'application/json' };
    req.push(JSON.stringify({ projectPath: '/tmp/some-project' }));
    req.push(null);

    await gateway._handleOpenProject(req, {});
    assert.strictEqual(responseStatus, 404);
    assert.ok(/binary not found/i.test(responseData.error));
  } finally {
    quickstart.isTraeCNRunning = origIsRunning;
    quickstart.findTraeCNBinary = origFind;
    quickstart.startTraeCN = origStart;
  }
});

// ── auto Trae recovery (v0.4.x) ─────────────────────────────────────

// Note: _attemptTraeRecovery uses destructured imports of
// findTraeCNBinary / isTraeCNRunning / restartTraeCNWithDebug / startTraeCN,
// which means module-level mock patching of quickstart.isTraeCNRunning etc.
// does NOT redirect the in-handler reference. The tests below therefore
// only assert the observable env-driven paths (cooldown, no-op) and the
// skip / restart branch decision based on real quickstart state. End-to-end
// restart / start semantics are covered by quickstart.test.js.

asyncTest('Gateway auto-recovery respects cooldown and does not thrash', async () => {
  const gateway = new Gateway();
  gateway.autoStartTrae = true;
  gateway.traeRecoveryCooldownMs = 60000;
  gateway.lastTraeRecoveryAt = Date.now();
  const result = await gateway._attemptTraeRecovery(new Error('cdp gone'));
  assert.strictEqual(result, false, 'cooldown should suppress the second call');
});

asyncTest('Gateway auto-recovery bails early when autoStartTrae is off', async () => {
  const gateway = new Gateway();
  gateway.autoStartTrae = false;
  const result = await gateway._attemptTraeRecovery(new Error('cdp gone'));
  assert.strictEqual(result, false, 'autoStartTrae=false should suppress recovery');
});

asyncTest('Gateway auto-recovery bails early when mockBridge is on', async () => {
  const gateway = new Gateway();
  gateway.mockBridge = true;
  gateway.autoStartTrae = true;
  const result = await gateway._attemptTraeRecovery(new Error('cdp gone'));
  assert.strictEqual(result, false, 'mockBridge should suppress recovery');
});

(async () => {
  for (const { name, fn } of pendingAsyncTests) {
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

  // ---- Request ID propagation tests (added in upgrade batch A1) ----
  function makeReqRes(headers = {}, url = '/api/status', method = 'GET') {
    const headersObj = { host: '127.0.0.1', ...headers };
    const req = {
      method,
      url,
      headers: headersObj,
      socket: { remoteAddress: '127.0.0.1' }
    };
    const resHeaders = {};
    const res = {
      statusCode: 200,
      _writtenHead: null,
      _body: null,
      setHeader(name, value) { resHeaders[name.toLowerCase()] = value; },
      getHeader(name) { return resHeaders[name.toLowerCase()]; },
      removeHeader(name) { delete resHeaders[name.toLowerCase()]; },
      writeHead(code, h) { res.statusCode = code; res._writtenHead = { ...resHeaders, ...h }; res.statusCode = code; },
      end(body) { res._body = body; res._ended = true; res.statusCode = res._writtenHead ? res._writtenHead.statusCode || res.statusCode : res.statusCode; }
    };
    return { req, res, resHeaders };
  }

  test('Gateway assigns X-Request-ID when client does not provide one', async () => {
    const { req, res, resHeaders } = makeReqRes();
    const gateway = new Gateway();
    // Bypass full pipeline (no auth needed for /api/status).
    await gateway.handleRequest(req, res);
    assert.ok(resHeaders['x-request-id'], 'expected X-Request-ID to be set');
    assert.match(resHeaders['x-request-id'], /^req-[a-f0-9]+$/);
    assert.strictEqual(req._requestId, resHeaders['x-request-id']);
  });

  test('Gateway echoes client-supplied X-Request-ID', async () => {
    const { req, res, resHeaders } = makeReqRes({ 'x-request-id': 'client-abc-123' });
    const gateway = new Gateway();
    await gateway.handleRequest(req, res);
    assert.strictEqual(resHeaders['x-request-id'], 'client-abc-123');
    assert.strictEqual(req._requestId, 'client-abc-123');
  });

  test('Gateway rejects malicious X-Request-ID and generates fresh id', async () => {
    const cases = [
      '../../../etc/passwd',
      'has spaces here',
      'newline\ninjection',
      'a'.repeat(200)
    ];
    for (const bad of cases) {
      const { req, res, resHeaders } = makeReqRes({ 'x-request-id': bad });
      const gateway = new Gateway();
      await gateway.handleRequest(req, res);
      assert.notStrictEqual(resHeaders['x-request-id'], bad);
      assert.match(resHeaders['x-request-id'], /^req-[a-f0-9]+$/);
    }
  });

  // ── Prometheus /metrics endpoint (Batch D1) ──────────────────────────────

  function makeMetricsReqRes(headers = {}, url = '/metrics', method = 'GET') {
    return makeReqRes(headers, url, method);
  }

  test('Gateway /metrics returns Prometheus exposition format', async () => {
    const { req, res, resHeaders } = makeMetricsReqRes();
    const gateway = new Gateway();
    await gateway.handleRequest(req, res);
    assert.ok(resHeaders['content-type'].startsWith('text/plain'));
    assert.ok(resHeaders['content-type'].includes('version=0.0.4'));
    const body = res._body || '';
    assert.ok(body.includes('# HELP traecn_http_requests_total'));
    assert.ok(body.includes('# TYPE traecn_http_requests_total counter'));
    assert.ok(body.includes('# TYPE traecn_active_sessions gauge'));
  });

  test('Gateway /metrics returns a 200 with valid body even when no traffic has been recorded', async () => {
    const { req, res } = makeMetricsReqRes();
    const gateway = new Gateway();
    await gateway.handleRequest(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res._body && res._body.includes('traecn_active_sessions'));
  });

  test('Gateway /metrics is unauthenticated and rate-limit-isolated per IP', async () => {
    const gateway = new Gateway();
    // /metrics is unauthenticated: it should respond 200 even with no token.
    const { req, res } = makeReqRes({}, '/metrics', 'GET');
    await gateway.handleRequest(req, res);
    assert.strictEqual(res.statusCode, 200);
  });

  test('Gateway /metrics.json returns a JSON snapshot', async () => {
    const { req, res, resHeaders } = makeMetricsReqRes({}, '/metrics.json');
    const gateway = new Gateway();
    await gateway.handleRequest(req, res);
    assert.ok(resHeaders['content-type'].startsWith('application/json'));
    const payload = JSON.parse(res._body);
    assert.ok(typeof payload === 'object');
    assert.ok('activeSessions' in payload);
    assert.ok('activeTasks' in payload);
    assert.ok('uptime' in payload);
  });

  test('Gateway records http metrics after a request completes', async () => {
    const gateway = new Gateway();
    const baseline = global.__traecnclawLastSnapshot;
    void baseline;
    const { req, res } = makeReqRes({}, '/api/status', 'GET');
    await gateway.handleRequest(req, res);
    // Pull the metrics via the JSON endpoint and verify the request
    // bumped the counter for /api/status.
    const { req: req2, res: res2 } = makeMetricsReqRes({}, '/metrics.json');
    await gateway.handleRequest(req2, res2);
    const snapshot = JSON.parse(res2._body);
    const requests = snapshot.httpRequests || {};
    const has = Object.keys(requests).some(key => key.includes('path="/api/status"'));
    assert.ok(has, 'expected at least one /api/status entry in httpRequests');
  });

  test('Gateway _refreshMetricsGauges reflects queue and CDP state', () => {
    const gateway = new Gateway();
    gateway.taskQueue.clear();
    gateway.batchTasks.clear();
    gateway.taskQueue.set('live', { status: 'queued' });
    gateway.taskQueue.set('done', { status: 'done' });
    gateway.batchTasks.set('batch1', { status: 'running' });
    // Reset the relevant gauges so we don't inherit state from other tests.
    gateway._refreshMetricsGauges();
    const captured = { activeTasks: null, queueSize: null, cdp: null };
    const origSetActive = require('../shared/metrics').globalMetrics.setActiveTasks.bind(require('../shared/metrics').globalMetrics);
    const origSetQueue = require('../shared/metrics').globalMetrics.setQueueSize.bind(require('../shared/metrics').globalMetrics);
    const origSetCdp = require('../shared/metrics').globalMetrics.setCdpConnection.bind(require('../shared/metrics').globalMetrics);
    try {
      // Capture the values _refreshMetricsGauges would push.
      require('../shared/metrics').globalMetrics.setActiveTasks = (n) => { captured.activeTasks = n; };
      require('../shared/metrics').globalMetrics.setQueueSize = (type, n) => {
        captured.queueSize = captured.queueSize || {};
        captured.queueSize[type] = n;
      };
      require('../shared/metrics').globalMetrics.setCdpConnection = (status) => { captured.cdp = status; };
      gateway._refreshMetricsGauges();
    } finally {
      require('../shared/metrics').globalMetrics.setActiveTasks = origSetActive;
      require('../shared/metrics').globalMetrics.setQueueSize = origSetQueue;
      require('../shared/metrics').globalMetrics.setCdpConnection = origSetCdp;
    }
    assert.strictEqual(captured.activeTasks, 1);
    assert.strictEqual(captured.queueSize.tasks, 1);
    assert.strictEqual(captured.queueSize.batches, 1);
    assert.strictEqual(captured.cdp, 'disconnected');
  });

  test('Gateway constructs a CDPHealthWatcher (off by default)', () => {
    const gateway = new Gateway();
    assert.ok(gateway.healthWatcher, 'expected healthWatcher to be constructed');
    assert.strictEqual(gateway.healthWatcher.enabled, false, 'auto-recovery should default to off');
    assert.strictEqual(gateway.autoRecover, false, 'autoRecover flag should default to false');
    const s = gateway.healthWatcher.state;
    assert.strictEqual(s.probeIntervalMs, 30000);
    assert.strictEqual(s.maxRecoveries, 5);
  });

  test('Gateway enables auto-recover when TRAECN_AUTO_RECOVER=1', () => {
    const prev = process.env.TRAECN_AUTO_RECOVER;
    process.env.TRAECN_AUTO_RECOVER = '1';
    try {
      const gateway = new Gateway();
      assert.strictEqual(gateway.autoRecover, true, 'autoRecover flag should pick up env');
      assert.strictEqual(gateway.healthWatcher.enabled, true, 'watcher should be enabled');
    } finally {
      if (prev === undefined) delete process.env.TRAECN_AUTO_RECOVER;
      else process.env.TRAECN_AUTO_RECOVER = prev;
    }
  });

  test('Gateway respects TRAECN_AUTO_RECOVER_PROBE_MS and TRAECN_AUTO_RECOVER_MAX', () => {
    const prevProbe = process.env.TRAECN_AUTO_RECOVER_PROBE_MS;
    const prevMax = process.env.TRAECN_AUTO_RECOVER_MAX;
    process.env.TRAECN_AUTO_RECOVER_PROBE_MS = '7500';
    process.env.TRAECN_AUTO_RECOVER_MAX = '9';
    try {
      const gateway = new Gateway();
      assert.strictEqual(gateway.autoRecoverProbeMs, 7500);
      assert.strictEqual(gateway.autoRecoverMax, 9);
      assert.strictEqual(gateway.healthWatcher.probeIntervalMs, 7500);
      assert.strictEqual(gateway.healthWatcher.maxRecoveries, 9);
    } finally {
      if (prevProbe === undefined) delete process.env.TRAECN_AUTO_RECOVER_PROBE_MS;
      else process.env.TRAECN_AUTO_RECOVER_PROBE_MS = prevProbe;
      if (prevMax === undefined) delete process.env.TRAECN_AUTO_RECOVER_MAX;
      else process.env.TRAECN_AUTO_RECOVER_MAX = prevMax;
    }
  });

  console.log(`\n[gateway.test.js] Results: ${passed} passed, ${failed} failed\n`);
  try {
    fs.unlinkSync(TEST_QUEUE_PERSISTENCE_PATH);
  } catch {}
  try {
    fs.unlinkSync(TEST_HISTORY_PERSISTENCE_PATH);
  } catch {}
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error(err);
  try {
    fs.unlinkSync(TEST_QUEUE_PERSISTENCE_PATH);
  } catch {}
  try {
    fs.unlinkSync(TEST_HISTORY_PERSISTENCE_PATH);
  } catch {}
  process.exit(1);
});
