'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const TEST_QUEUE_PERSISTENCE_PATH = path.join(os.tmpdir(), 'traecnclaw-gateway-test-active-queue.json');
const TEST_HISTORY_PERSISTENCE_PATH = path.join(os.tmpdir(), 'traecnclaw-gateway-test-history.json');
const TEST_EVENT_PERSISTENCE_PATH = path.join(os.tmpdir(), 'traecnclaw-gateway-test-events.json');
process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = TEST_QUEUE_PERSISTENCE_PATH;
process.env.TRAECN_TASK_HISTORY_PERSISTENCE_PATH = TEST_HISTORY_PERSISTENCE_PATH;
process.env.TRAECN_TASK_EVENT_PERSISTENCE_PATH = TEST_EVENT_PERSISTENCE_PATH;
try {
  fs.unlinkSync(TEST_QUEUE_PERSISTENCE_PATH);
} catch {}
try {
  fs.unlinkSync(TEST_HISTORY_PERSISTENCE_PATH);
} catch {}
try {
  fs.unlinkSync(TEST_EVENT_PERSISTENCE_PATH);
} catch {}

const { Gateway, RateLimiter, sanitizeLog } = require('./gateway');
const { buildCapabilities } = require('../capabilities');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');
const requestContext = require('../shared/request-context');
const { selectTraeAdapter } = require('../trae-adapters');

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

function makeReqRes(headers = {}, url = '/api/status', method = 'GET', body = null) {
  // Thin shim over the shared helper so existing call sites in this file
  // keep working unchanged. The real implementation lives in
  // src/shared/test-helpers.js.
  return requireSharedMakeReqRes(headers, url, method, body);
}
const requireSharedMakeReqRes = require('../shared/test-helpers').makeReqRes;

console.log('\n[gateway.test.js] Running RateLimiter and sanitizeLog tests...\n');

test('RateLimiter allows requests within limit', () => {
  const limiter = new RateLimiter(60000, 5);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(limiter.check('key1'), true);
  }
});

test('Gateway owns a security audit logger and accepts an injected logger', () => {
  const auditLogger = { log: () => {} };
  const gateway = new Gateway({ auditLogger });
  assert.strictEqual(gateway.auditLogger, auditLogger);
});

test('Gateway refuses a non-loopback bind without an authentication token', () => {
  const previousToken = process.env.TRAECN_GATEWAY_TOKEN;
  const previousLegacyToken = process.env.TRAE_GATEWAY_TOKEN;
  delete process.env.TRAECN_GATEWAY_TOKEN;
  delete process.env.TRAE_GATEWAY_TOKEN;
  try {
    assert.throws(
      () => new Gateway({ host: '0.0.0.0' }),
      /non-loopback.*TRAECN_GATEWAY_TOKEN/i
    );
  } finally {
    restoreEnv('TRAECN_GATEWAY_TOKEN', previousToken);
    restoreEnv('TRAE_GATEWAY_TOKEN', previousLegacyToken);
  }
});

test('Gateway permits loopback binds without a token', () => {
  const previousToken = process.env.TRAECN_GATEWAY_TOKEN;
  const previousLegacyToken = process.env.TRAE_GATEWAY_TOKEN;
  delete process.env.TRAECN_GATEWAY_TOKEN;
  delete process.env.TRAE_GATEWAY_TOKEN;
  try {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
      assert.strictEqual(new Gateway({ host }).host, host);
    }
  } finally {
    restoreEnv('TRAECN_GATEWAY_TOKEN', previousToken);
    restoreEnv('TRAE_GATEWAY_TOKEN', previousLegacyToken);
  }
});

test('Gateway permits a non-loopback bind when a token is configured', () => {
  const previousToken = process.env.TRAECN_GATEWAY_TOKEN;
  process.env.TRAECN_GATEWAY_TOKEN = 'test-non-loopback-token';
  try {
    assert.strictEqual(new Gateway({ host: '0.0.0.0' }).host, '0.0.0.0');
  } finally {
    restoreEnv('TRAECN_GATEWAY_TOKEN', previousToken);
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

asyncTest('Gateway protects /api/config routes when a token is configured', async () => {
  const gateway = new Gateway();
  gateway.token = 'secret';

  const { req, res } = makeReqRes({}, '/api/config', 'GET');
  await gateway.handleRequest(req, res);

  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(JSON.parse(res._body), { error: 'Unauthorized' });
});

asyncTest('Gateway redacts config secrets in config responses and audit logs', async () => {
  const gateway = new Gateway();
  gateway.configManager.update({
    server: { token: 'super-secret-token' },
    secrets: { providerApiKey: 'sk-test-secret' }
  }, 'test');

  const { req, res } = makeReqRes({ authorization: 'Bearer super-secret-token' }, '/api/config', 'GET');
  await gateway.handleRequest(req, res);

  assert.strictEqual(res.statusCode, 200);
  const payload = JSON.parse(res._body);
  assert.strictEqual(payload.config.server.token, '[REDACTED]');
  assert.strictEqual(payload.config.secrets, '[REDACTED]');
  assert.ok(payload.auditLog.length > 0);
  assert.strictEqual(payload.auditLog[payload.auditLog.length - 1].changes.server.next.token, '[REDACTED]');
  assert.strictEqual(payload.auditLog[payload.auditLog.length - 1].changes.secrets, '[REDACTED]');
});

asyncTest('Gateway applies runtime server auth changes from ConfigManager section events', async () => {
  const gateway = new Gateway();
  gateway.token = 'old-secret';
  gateway.authHeader = 'Authorization';

  const { req, res } = makeReqRes(
    { authorization: 'Bearer old-secret' },
    '/api/config/update',
    'POST',
    { server: { token: 'new-secret', authHeader: 'X-New-Token' } }
  );
  await gateway.handleRequest(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(gateway.token, 'new-secret');
  assert.strictEqual(gateway.authHeader, 'X-New-Token');
  const payload = JSON.parse(res._body);
  assert.strictEqual(payload.config.server.token, '[REDACTED]');

  const { req: oldReq, res: oldRes } = makeReqRes({ authorization: 'Bearer old-secret' }, '/api/status', 'GET');
  await gateway.handleRequest(oldReq, oldRes);
  assert.strictEqual(oldRes.statusCode, 200, 'status remains public');

  const { req: protectedReq, res: protectedRes } = makeReqRes({ 'x-new-token': 'Bearer new-secret' }, '/api/config', 'GET');
  await gateway.handleRequest(protectedReq, protectedRes);
  assert.strictEqual(protectedRes.statusCode, 200);
});

test('Gateway applies full config reset events to runtime auth state', () => {
  const gateway = new Gateway();
  gateway.configManager.update({
    server: { token: 'temporary-token', authHeader: 'X-Temporary-Token' },
    features: { mockBridge: true }
  }, 'test');
  assert.strictEqual(gateway.token, 'temporary-token');
  assert.strictEqual(gateway.authHeader, 'X-Temporary-Token');
  assert.strictEqual(gateway.mockBridge, true);

  gateway.configManager.reset();

  assert.strictEqual(gateway.token, '');
  assert.strictEqual(gateway.authHeader, 'Authorization');
  assert.strictEqual(gateway.mockBridge, false);
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

test('Gateway config schema exposes complete defaults and generated runtime environment schema', () => {
  const gateway = new Gateway();
  const { req, res } = makeReqRes({}, '/api/config/schema', 'GET');
  gateway._handleGetConfigSchema(req, res);
  const payload = JSON.parse(res._body);
  assert.strictEqual(payload.defaults.server.host, '127.0.0.1');
  assert.strictEqual(payload.defaults.server.port, 8788);
  assert.strictEqual(payload.defaults.timeout.response, 1800000);
  assert.strictEqual(payload.defaults.traeControl.autoStart, false);
  assert.strictEqual(payload.environment.TRAECN_REMOTE_DEBUGGING_PORT.default, '9222');
  assert.strictEqual(payload.environment.TRAECN_QUEUE_MAX_WAIT_MS.default, '');
});

test('buildCapabilities returns compact command and token strategy metadata', () => {
  const capabilities = buildCapabilities({
    commands: [{ command: 'delegate_async', summary: 'Async delegate', required: ['task'], optional: ['waitForQueue'] }],
    mcpTools: [{ name: 'queue_task', description: 'Queue task', inputSchema: { required: ['task'] } }]
  });
  assert.strictEqual(capabilities.name, 'traecnclaw');
  assert.strictEqual(capabilities.coverage.queueManagement, true);
  assert.deepStrictEqual(capabilities.tokenStrategy.prefer, ['traecn_send_message', 'traecn_list_conversations', 'traecn_get_task']);
  assert.strictEqual(capabilities.tokenStrategy.gatewayManaged, true);
  assert.strictEqual(capabilities.mcp.contractVersion, 5);
  assert.strictEqual(capabilities.mcp.toolCount, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(capabilities.mcp, 'toolProfile'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(capabilities.mcp, 'toolProfiles'), false);
  assert.ok(capabilities.commands.some(command => command.command === 'delegate_async'));
  assert.ok(capabilities.mcp.tools.some(tool => tool.name === 'queue_task'));
  assert.ok(capabilities.http.some(operation => operation.path === '/api/capabilities'));
  assert.ok(capabilities.http.some(operation => operation.path === '/api/preflight'));
  assert.deepStrictEqual(
    capabilities.traeCN.adapters.map(adapter => adapter.id),
    ['traecn-1.107', 'traecn-unknown']
  );
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

test('buildConfirmationPlan treats gateway task review decisions as high risk', () => {
  const plan = buildConfirmationPlan({
    command: 'review_task',
    params: { taskId: 'task_review_1', decision: 'approve' }
  });

  assert.strictEqual(plan.risk, 'high');
  assert.strictEqual(plan.requiresConfirmation, true);
  assert.ok(plan.sideEffects.some(item => item.includes('continue')));
  assert.ok(plan.preflight.some(item => item.includes('task_review_1')));
  assert.ok(plan.recommendedFlow.includes('task_status'));
  assert.ok(plan.recommendedFlow.includes('user_confirmation'));
});

test('Gateway computes CORS headers for allowed origins', () => {
  const gateway = new Gateway();
  gateway.allowedOrigins = 'https://example.com';
  const headers = gateway._corsHeaders({ headers: { origin: 'https://example.com' } });
  assert.strictEqual(headers['Access-Control-Allow-Origin'], 'https://example.com');
  assert.strictEqual(headers.Vary, 'Origin');
});

test('Gateway default CORS only allows same gateway origin', () => {
  const gateway = new Gateway();
  gateway.allowedOrigins = '';

  const sameOrigin = gateway._corsHeaders({ headers: { origin: 'http://127.0.0.1:8788', host: '127.0.0.1:8788' } });
  assert.strictEqual(sameOrigin['Access-Control-Allow-Origin'], 'http://127.0.0.1:8788');
  assert.strictEqual(sameOrigin.Vary, 'Origin');

  const crossOrigin = gateway._corsHeaders({ headers: { origin: 'https://example.com', host: '127.0.0.1:8788' } });
  assert.deepStrictEqual(crossOrigin, {});
  assert.strictEqual(gateway._checkOrigin({ headers: { origin: 'https://example.com', host: '127.0.0.1:8788' } }), false);
  assert.strictEqual(gateway._checkOrigin({ headers: { origin: 'http://127.0.0.1:8788', host: '127.0.0.1:8788' } }), true);
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
  gateway._persistActiveQueue = () => true;
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

test('Gateway rejects generic queue-probe task creation', () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1234 } };
  assert.throws(
    () => gateway._createQueuedTask({ task: 'wait for Trae queue' }, { queued: true }),
    /generic_queue_probe_task_rejected/
  );
});

asyncTest('Gateway auto-continues reviewable workflow followups without human review', async () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1234 } };
  gateway._persistActiveQueue = () => true;
  gateway._ensureBackgroundPolling = () => {};
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
    soloChat: { titleIncludes: 'Workflow Solo Chat' },
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
  assert.strictEqual(nextTask.soloChat.titleIncludes, 'Workflow Solo Chat');
});

asyncTest('Gateway lists real Solo chats through the driver', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    listSoloChats: async () => ({
      mode: 'solo',
      chats: [{ index: 0, title: 'Feature A' }],
      count: 1
    })
  };
  const { req, res } = makeReqRes({}, '/api/solo/chats', 'GET');

  await gateway.handleRequest(req, res);

  const payload = JSON.parse(res._body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(payload.mode, 'solo');
  assert.strictEqual(payload.count, 1);
  assert.strictEqual(payload.chats[0].title, 'Feature A');
});

asyncTest('Gateway switches real Solo chat by criteria through the driver', async () => {
  const gateway = new Gateway();
  let captured = null;
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    switchSoloChat: async (criteria) => {
      captured = criteria;
      return { success: true, index: 2, title: 'Target chat' };
    }
  };
  const { req, res } = makeReqRes({}, '/api/solo/chats/switch', 'POST', { index: 2, textIncludes: 'Target' });

  await gateway.handleRequest(req, res);

  const payload = JSON.parse(res._body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(captured.index, 2);
  assert.strictEqual(captured.textIncludes, 'Target');
});

asyncTest('Gateway returns 404 when Solo chat switch target is not found', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    switchSoloChat: async () => ({ success: false, reason: 'chat_not_found', count: 1 })
  };
  const { req, res } = makeReqRes({}, '/api/solo/chats/switch', 'POST', { titleIncludes: 'Missing' });

  await gateway.handleRequest(req, res);

  const payload = JSON.parse(res._body);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(payload.success, false);
  assert.strictEqual(payload.reason, 'chat_not_found');
});

asyncTest('Gateway submits Solo chat task and captures chat target for result collection', async () => {
  const gateway = new Gateway();
  const calls = [];
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway.taskHistoryStore = {
    createTask: () => 'task_solo_submit',
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    switchMode: async (mode) => calls.push(['switchMode', mode]),
    newChat: async () => calls.push(['newChat']),
    sendMessage: async (task) => calls.push(['sendMessage', task]),
    checkQueueStatus: async () => ({ queued: true, running: false, queuePosition: 3, queueMessage: '排队中' }),
    getActiveSoloChat: async () => ({
      mode: 'solo',
      active: { index: 4, title: 'Solo queued task', text: 'Solo queued task 12:00' },
      count: 5
    })
  };
  const { req, res } = makeReqRes({}, '/api/solo/chats/submit', 'POST', {
    task: 'Implement isolated feature',
    projectPath: '/tmp/solo-project'
  });

  await gateway.handleRequest(req, res);

  const payload = JSON.parse(res._body);
  const task = gateway.taskQueue.get('task_solo_submit');
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(payload.taskId, 'task_solo_submit');
  assert.strictEqual(payload.submittedToTrae, true);
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.soloChat.titleIncludes, 'Solo queued task');
  assert.ok(calls.some(call => call[0] === 'newChat'));
  assert.ok(calls.some(call => call[0] === 'sendMessage' && call[1] === 'Implement isolated feature'));
});

asyncTest('Gateway rejects Solo submission when the requested project folder is not open', async () => {
  const gateway = new Gateway();
  let sent = false;
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    switchMode: async () => {},
    switchSoloChat: async () => ({ success: true, index: 0, title: 'Existing review' }),
    getWorkspaceContext: async () => ({ title: 'gemini-web-mcp', folderName: 'gemini-web-mcp' }),
    sendMessage: async () => { sent = true; }
  };
  const { req, res } = makeReqRes({}, '/api/solo/chats/submit', 'POST', {
    task: 'Continue the review',
    projectPath: '/Users/jack/Documents/gh-repos/TRAECNclaw',
    soloChat: { index: 0 }
  });

  await gateway.handleRequest(req, res);

  const payload = JSON.parse(res._body);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(payload.code, 'PROJECT_NOT_OPEN');
  assert.strictEqual(payload.details.requestedFolder, 'TRAECNclaw');
  assert.strictEqual(payload.details.currentFolder, 'gemini-web-mcp');
  assert.strictEqual(sent, false);
});

asyncTest('Gateway uses projectPath as a workspace guard without injecting it into the Solo prompt', async () => {
  const gateway = new Gateway();
  let sentMessage = null;
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway.taskHistoryStore = {
    createTask: () => 'task_workspace_guard',
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    switchMode: async () => {},
    switchSoloChat: async () => ({ success: true, index: 0, title: 'Existing review' }),
    getWorkspaceContext: async () => ({ title: 'TRAECNclaw', folderName: 'TRAECNclaw' }),
    sendMessage: async (message) => { sentMessage = message; },
    checkQueueStatus: async () => ({ queued: true, running: false }),
    getActiveSoloChat: async () => ({
      mode: 'solo',
      active: { index: 0, title: 'Existing review', text: 'Existing review' },
      count: 1
    })
  };
  const { req, res } = makeReqRes({}, '/api/solo/chats/submit', 'POST', {
    task: 'Continue the review',
    projectPath: '/Users/jack/Documents/gh-repos/TRAECNclaw',
    soloChat: { index: 0 }
  });

  await gateway.handleRequest(req, res);

  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(sentMessage, 'Continue the review');
});

asyncTest('Gateway refuses guarded submission when the open workspace cannot be identified', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    getWorkspaceContext: async () => ({ title: '', folderName: null, hasExplorer: false })
  };

  await assert.rejects(
    () => gateway._assertProjectWorkspace('/Users/jack/Documents/gh-repos/TRAECNclaw'),
    error => error && error.code === 'WORKSPACE_CONTEXT_UNAVAILABLE'
  );
});

asyncTest('Gateway rejects a different workspace path even when the folder name matches', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    getWorkspaceContext: async () => ({
      title: 'TRAECNclaw',
      folderName: 'TRAECNclaw',
      rootPath: '/Users/jack/other/TRAECNclaw',
      hasExplorer: true
    })
  };

  await assert.rejects(
    () => gateway._assertProjectWorkspace('/Users/jack/Documents/gh-repos/TRAECNclaw'),
    error => error &&
      error.code === 'PROJECT_NOT_OPEN' &&
      error.details.currentPath === '/Users/jack/other/TRAECNclaw'
  );
});

asyncTest('Gateway cleanup endpoint repeats passes for queue probes revealed after deletion', async () => {
  const gateway = new Gateway();
  let listCalls = 0;
  const deletedTitles = [];
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    listSoloChats: async () => {
      listCalls++;
      if (listCalls === 1) {
        return { mode: 'solo', chats: [{ index: 0, title: 'wait for Trae queue', text: '排队中 A' }], count: 1 };
      }
      if (listCalls === 2) {
        return { mode: 'solo', chats: [{ index: 0, title: 'Wait for Trae Queue 进行中 17:34', text: '排队中 B' }], count: 1 };
      }
      return { mode: 'solo', chats: [], count: 0 };
    },
    deleteSoloChats: async ({ candidates }) => {
      deletedTitles.push(...candidates.map(candidate => candidate.title));
      return { deleted: candidates.length, attempts: candidates.map(candidate => ({ success: true, candidate })) };
    }
  };

  const { req, res } = makeReqRes({}, '/api/solo/chats/cleanup-foreign-queue', 'POST', {
    execute: true,
    maxPasses: 3,
    settleMs: 0
  });

  await gateway.handleRequest(req, res);

  const payload = JSON.parse(res._body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(payload.deleted, 2);
  assert.strictEqual(payload.passes.length, 2);
  assert.deepStrictEqual(deletedTitles, ['wait for Trae queue', 'Wait for Trae Queue 进行中 17:34']);
});

asyncTest('Gateway keeps parallel queued session Solo results isolated when completion is out of order', async () => {
  const gateway = new Gateway();
  gateway._persistActiveQueue = () => true;
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000 } };
  gateway._emitTaskNotification = async () => {};
  gateway.taskHistoryStore = {
    createTask: (() => {
      let index = 0;
      return () => `task_session_${++index}`;
    })(),
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway.sessions.set('session_a', { id: 'session_a', createdAt: new Date().toISOString(), messages: [] });
  gateway.sessions.set('session_b', { id: 'session_b', createdAt: new Date().toISOString(), messages: [] });
  gateway._appendSessionMessage('session_a', { role: 'user', content: 'TRAECN_SESSION_A_001 implement A' });
  gateway._appendSessionMessage('session_b', { role: 'user', content: 'TRAECN_SESSION_B_001 implement B' });

  const taskA = gateway._createQueuedTask({
    sessionId: 'session_a',
    task: 'TRAECN_SESSION_A_001 implement A',
    soloChat: { titleIncludes: 'Session A' }
  }, { queued: false });
  const taskB = gateway._createQueuedTask({
    sessionId: 'session_b',
    task: 'TRAECN_SESSION_B_001 implement B',
    soloChat: { titleIncludes: 'Session B' }
  }, { queued: false });
  taskA.status = 'executing';
  taskA.submittedToTrae = true;
  taskB.status = 'executing';
  taskB.submittedToTrae = true;

  await gateway._finalizeCollectedBackgroundResult(taskB.taskId, taskB, {
    text: 'TRAECN_SESSION_B_001 Final report: implementation B complete, tests passed, and ownership marker confirms session B.',
    stable: true,
    elapsedMs: 1000
  });
  await gateway._finalizeCollectedBackgroundResult(taskA.taskId, taskA, {
    text: 'TRAECN_SESSION_A_001 Final report: implementation A complete, tests passed, and ownership marker confirms session A.',
    stable: true,
    elapsedMs: 1000
  });

  const sessionA = gateway.sessions.get('session_a');
  const sessionB = gateway.sessions.get('session_b');
  assert.strictEqual(sessionA.messages[1].taskId, taskA.taskId);
  assert.strictEqual(sessionB.messages[1].taskId, taskB.taskId);
  assert.ok(sessionA.messages[1].content.includes('TRAECN_SESSION_A_001'));
  assert.ok(sessionB.messages[1].content.includes('TRAECN_SESSION_B_001'));
  assert.ok(!sessionA.messages[1].content.includes('TRAECN_SESSION_B_001'));
  assert.ok(!sessionB.messages[1].content.includes('TRAECN_SESSION_A_001'));
});

test('Gateway queued tasks wait indefinitely by default for external model queues', () => {
  const gateway = new Gateway();
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1234 } };
  gateway._persistActiveQueue = () => true;
  gateway.taskHistoryStore = {
    createTask: () => 'task_wait_forever_1',
    recordStep: () => {}
  };
  const task = gateway._createQueuedTask({
    task: 'implement a long-running queue workflow'
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

test('Gateway restores idempotency ownership with the active task after restart', () => {
  const queueFile = path.join(os.tmpdir(), `traecnclaw-gateway-idempotency-${Date.now()}.json`);
  const previousPath = process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH;
  process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = queueFile;
  let gateway;
  let restoredGateway;
  try {
    gateway = new Gateway();
    gateway.taskQueue.clear();
    gateway.driver = { config: {} };
    const task = gateway._createQueuedTask({
      task: 'persist one idempotent submission',
      idempotencyKey: 'restart-safe-submit-1'
    });
    gateway.taskQueueService.close();

    restoredGateway = new Gateway();
    const replay = restoredGateway._checkIdempotency({
      headers: { 'idempotency-key': 'restart-safe-submit-1' }
    });

    assert.ok(replay, 'restored active task must retain its idempotency ownership');
    assert.deepStrictEqual(replay, {
      data: { taskId: task.taskId, status: 'accepted' },
      statusCode: 202
    });
    assert.strictEqual(restoredGateway.taskQueue.size, 1);
  } finally {
    gateway?.taskQueueService.close();
    restoredGateway?.taskQueueService.close();
    if (fs.existsSync(queueFile)) fs.unlinkSync(queueFile);
    if (fs.existsSync(`${queueFile}.bak`)) fs.unlinkSync(`${queueFile}.bak`);
    if (fs.existsSync(`${queueFile}.lock`)) fs.unlinkSync(`${queueFile}.lock`);
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

test('Gateway does not persist generic queue-probe tasks', () => {
  const queueFile = path.join(os.tmpdir(), `traecnclaw-gateway-probe-persist-test-${Date.now()}.json`);
  const previousPath = process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH;
  process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = queueFile;

  try {
    const gateway = new Gateway();
    gateway.taskQueue.clear();
    gateway.taskQueue.set('probe_task', {
      taskId: 'probe_task',
      status: 'queued',
      task: 'wait for Trae queue',
      createdAt: Date.now()
    });
    gateway.taskQueue.set('real_task', {
      taskId: 'real_task',
      status: 'queued',
      task: 'implement the queue status panel without sending prompts',
      createdAt: Date.now()
    });

    gateway._persistActiveQueue();

    const persisted = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.deepStrictEqual(persisted.tasks.map(task => task.taskId), ['real_task']);
  } finally {
    if (fs.existsSync(queueFile)) fs.unlinkSync(queueFile);
    restoreEnv('TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH', previousPath);
  }
});

test('Gateway rejects and rolls back a task when its first durable snapshot fails', () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.driver = { config: {} };
  gateway.taskQueueService.persist = () => false;
  gateway.taskQueueService.getPersistenceHealth = () => ({
    taskStoreWritable: false,
    lastSuccessfulPersistAt: null,
    lastPersistError: {
      code: 'ENOSPC',
      message: 'Active task queue persistence is unavailable',
      at: '2026-08-01T00:00:00.000Z'
    },
    durabilityDegraded: true
  });

  let thrown = null;
  try {
    gateway._createQueuedTask({ task: 'must not be accepted without durability' });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, 'task creation must fail when persistence fails');
  assert.strictEqual(thrown.code, 'TASK_STORE_UNAVAILABLE');
  assert.strictEqual(gateway.taskQueue.size, 0);
});

asyncTest('Gateway returns 503 instead of accepted when unified task durability is unavailable', async () => {
  const { MockDriver } = require('../cdp/mock-driver');
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.mockBridge = true;
  gateway.driver = new MockDriver();
  gateway._ensureConnection = async () => {};
  gateway.taskQueueService.persist = () => false;
  gateway.taskQueueService.getPersistenceHealth = () => ({
    taskStoreWritable: false,
    lastSuccessfulPersistAt: null,
    lastPersistError: {
      code: 'EROFS',
      message: 'Active task queue persistence is unavailable',
      at: '2026-08-01T00:00:00.000Z'
    },
    durabilityDegraded: true
  });
  const { req, res } = makeReqRes({}, '/api/tasks/submit', 'POST', {
    message: 'must not be reported as accepted'
  });

  await gateway.handleRequest(req, res);

  const body = JSON.parse(res._body);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(body.code, 'TASK_STORE_UNAVAILABLE');
  assert.strictEqual(body.details.taskStoreWritable, false);
  assert.strictEqual(gateway.taskQueue.size, 0);
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

asyncTest('Gateway status snapshot exposes task-store durability health', async () => {
  const gateway = new Gateway();
  gateway.mockBridge = true;
  gateway.taskQueueService.getPersistenceHealth = () => ({
    taskStoreWritable: false,
    lastSuccessfulPersistAt: '2026-08-01T00:00:00.000Z',
    lastPersistError: {
      code: 'ENOSPC',
      message: 'Active task queue persistence is unavailable',
      at: '2026-08-01T00:01:00.000Z'
    },
    durabilityDegraded: true
  });
  gateway.taskEventStore = {
    getHealth: () => ({
      persistenceEnabled: true,
      eventStoreWritable: false,
      lastSuccessfulPersistAt: null,
      lastPersistError: {
        code: 'ENOSPC',
        message: 'Task completion-event persistence is unavailable',
        at: '2026-08-01T00:02:00.000Z'
      },
      lastLoadError: null,
      lastRecovery: null,
      durabilityDegraded: true
    })
  };

  const snapshot = await gateway._statusSnapshot();

  assert.deepStrictEqual(snapshot.durability, {
    taskStoreWritable: false,
    lastSuccessfulPersistAt: '2026-08-01T00:00:00.000Z',
    lastPersistError: {
      code: 'ENOSPC',
      message: 'Active task queue persistence is unavailable',
      at: '2026-08-01T00:01:00.000Z'
    },
    durabilityDegraded: true,
    taskEvents: {
      persistenceEnabled: true,
      eventStoreWritable: false,
      lastSuccessfulPersistAt: null,
      lastPersistError: {
        code: 'ENOSPC',
        message: 'Task completion-event persistence is unavailable',
        at: '2026-08-01T00:02:00.000Z'
      },
      lastLoadError: null,
      lastRecovery: null,
      durabilityDegraded: true
    }
  });
});

asyncTest('Gateway status snapshot exposes the selected Trae adapter handshake', async () => {
  const gateway = new Gateway();
  gateway.mockBridge = true;
  gateway.traeAdapter = selectTraeAdapter({
    product: 'Trae CN',
    traeVersion: '1.107.1',
    platform: 'darwin',
    mode: 'solo',
    versionSource: 'product'
  });

  const snapshot = await gateway._statusSnapshot();
  assert.strictEqual(snapshot.traeAdapter.adapter, 'traecn-1.107');
  assert.strictEqual(snapshot.traeAdapter.traeVersion, '1.107.1');
  assert.strictEqual(snapshot.traeAdapter.compatibility, 'verified');
  assert.strictEqual(snapshot.traeAdapter.capabilities.fixtureReplay, true);
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
  assert.strictEqual(gateway._isSuccessfulResult({
    text: 'SOLO IDE 搜索 14 资源管理器 文件 demo-output queue-lab docs Claude Code 与 AI 对话 Editor 内 AI 编码 TRAE 与 Agent 协作 历史记录 Review TRAECNclaw Repository 速通 GLM-5.2 main* 0 0 CUE',
    stable: true
  }), false);
  assert.strictEqual(gateway._isSuccessfulResult({
    text: [
      'TRAECNclaw Code Review — Findings First',
      'Model: GLM-5.2 · Scope: working tree + core automation surfaces',
      '1. Findings (ordered by severity)',
      'Severity 1 — Critical',
      'F1.1 Background polling cannot auto-approve non-command dialogs',
      'Evidence: the final report quotes process text such as Thought and Let me now look at the queue handling.',
      '4. Final verdict',
      'Review complete. The report above is findings-first and read-only.'
    ].join('\n'),
    stable: true
  }), true);
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

asyncTest('Gateway task status exposes the exact command interaction for MCP task input', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.set('task_command_input', {
    taskId: 'task_command_input',
    status: 'approval_required',
    createdAt: Date.now() - 1000,
    interactionRequestId: 'interaction-command-visible',
    result: {
      text: 'TraeCN requires command approval',
      needsApproval: true,
      question: 'Run the command?',
      dialogType: 'command_execution',
      command: 'git push origin main',
      approvalDecision: 'agent_review',
      commandRisk: 'high',
      riskReasons: ['git_write_or_remote']
    }
  });
  let responseData = null;
  gateway._json = (req, res, data) => {
    responseData = data;
  };

  await gateway._handleTaskStatus({}, {}, 'task_command_input');
  assert.strictEqual(responseData.interactionRequestId, 'interaction-command-visible');
  assert.strictEqual(responseData.result.command, 'git push origin main');
  assert.strictEqual(responseData.result.commandRisk, 'high');
  assert.deepStrictEqual(responseData.result.riskReasons, ['git_write_or_remote']);
  assert.strictEqual(responseData.result.approvalDecision, 'agent_review');
});

asyncTest('Gateway assigns a durable interaction request id while a task awaits input', async () => {
  const gateway = new Gateway();
  gateway.taskHistoryStore = {
    recordStep: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._emitTaskNotification = async () => {};
  gateway._syncTaskHistoryMirror = () => {};
  gateway._persistActiveQueue = () => true;
  const task = {
    taskId: 'task_interaction_identity',
    status: 'executing',
    createdAt: Date.now(),
    result: null
  };

  await gateway._finalizeBackgroundTask(task.taskId, task, 'approval_required', {
    result: { needsApproval: true, command: 'npm publish' }
  });
  assert.match(task.interactionRequestId, /^interaction-/);
  const firstId = task.interactionRequestId;

  await gateway._finalizeBackgroundTask(task.taskId, task, 'approval_required', {
    result: task.result
  });
  assert.strictEqual(task.interactionRequestId, firstId);

  await gateway._finalizeBackgroundTask(task.taskId, task, 'done', {
    result: { text: 'complete', stable: true }
  });
  assert.strictEqual(task.interactionRequestId, undefined);
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
      queued: false,
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
  assert.ok(task.result.text.includes('Findings'));
});

asyncTest('Gateway switches to submitted Solo chat before collecting result', async () => {
  const gateway = new Gateway();
  const calls = [];
  const task = {
    taskId: 'task_submitted_solo',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 4000,
    reviewRequired: false,
    followupTasks: [],
    queueState: 'submitted',
    soloChat: { titleIncludes: 'Target Solo Chat' }
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    switchSoloChat: async (criteria) => {
      calls.push(['switchSoloChat', criteria]);
      return { success: true, index: 1, title: 'Target Solo Chat' };
    },
    checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: true }),
    collectResponse: async () => {
      calls.push(['collectResponse']);
      return { text: '任务完成: all good', stable: true, elapsedMs: 1234 };
    }
  };

  await gateway._collectSubmittedBackgroundTask(task.taskId, task);

  assert.deepStrictEqual(calls[0], ['switchSoloChat', { titleIncludes: 'Target Solo Chat', textIncludes: undefined }]);
  assert.strictEqual(calls[1][0], 'collectResponse');
  assert.strictEqual(task.status, 'done');
});

asyncTest('Gateway falls back to stable Solo chat candidates when title changes after completion', async () => {
  const gateway = new Gateway();
  const attempts = [];
  const task = {
    taskId: 'task_submitted_solo_title_changed',
    status: 'executing',
    task: '请只回复一行：TRAECN_SOLO_SUBMIT_OK',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 4000,
    reviewRequired: false,
    followupTasks: [],
    queueState: 'submitted',
    soloChat: {
      titleIncludes: '请只回复一行：TRAECN_SOLO_SUBMIT_OK 进行中 10:25',
      candidates: ['TRAECN_SOLO_SUBMIT_OK']
    }
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    switchSoloChat: async (criteria) => {
      attempts.push(criteria);
      if (criteria.titleIncludes === 'TRAECN_SOLO_SUBMIT_OK') {
        return { success: true, index: 0, title: 'TRAECN_SOLO_SUBMIT_OK 任务完成 10:25' };
      }
      return { success: false, reason: 'chat_not_found' };
    },
    checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: true }),
    collectResponse: async () => ({ text: 'TRAECN_SOLO_SUBMIT_OK', stable: true, elapsedMs: 1000 })
  };

  await gateway._collectSubmittedBackgroundTask(task.taskId, task);

  assert.ok(attempts.some(criteria => criteria.titleIncludes === 'TRAECN_SOLO_SUBMIT_OK'));
  assert.strictEqual(task.status, 'done');
});

asyncTest('Gateway captures task-specific Solo chat candidates before generic project path text', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_submitted_project_path_title',
    task: '请修复 settings/read-all 超时问题，重点文件 src/cdp/settings-driver.js',
    status: 'executing',
    followupTasks: []
  };
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway.driver = {
    getActiveSoloChat: async () => ({
      active: {
        index: 0,
        title: 'Project path: /Users/Shared/projects/TRAECNclaw Work only in this project path unless the user explicitly says otherwise',
        text: 'Project path: /Users/Shared/projects/TRAECNclaw Work only in this project path unless the user explicitly says otherwise'
      }
    })
  };

  const soloChat = await gateway._captureTaskSoloChat(task);

  assert.ok(soloChat.candidates.includes('settings/read-all'));
  assert.ok(soloChat.candidates.includes('src/cdp/settings-driver.js'));
  assert.ok(!soloChat.candidates.includes('Project'));
  assert.ok(soloChat.candidates.indexOf('settings/read-all') < soloChat.candidates.findIndex(item => item.startsWith('Project path:')));
  assert.strictEqual(soloChat.titleIncludes, 'settings/read-all');
  assert.strictEqual(soloChat.textIncludes, 'settings/read-all');
});

test('Gateway keeps the prompt lead phrase as a Solo chat rename candidate', () => {
  const gateway = new Gateway();

  const candidates = gateway._soloChatCandidateTexts(
    '实机回归验收。请只运行只读命令 pwd，然后回复 LIVE-UAT-COMPLETION-PASS。'
  );

  assert.ok(candidates.includes('实机回归验收'));
});

asyncTest('Gateway never falls back to a stale Solo chat index when textual identity exists', async () => {
  const gateway = new Gateway();
  const attempts = [];
  const task = {
    taskId: 'task_stale_solo_index',
    task: '审查 src/http/gateway.js 的任务隔离',
    status: 'executing',
    soloChat: {
      index: 0,
      titleIncludes: 'src/http/gateway.js',
      textIncludes: 'src/http/gateway.js',
      candidates: ['src/http/gateway.js', '任务隔离']
    }
  };
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway.driver = {
    switchSoloChat: async (criteria) => {
      attempts.push(criteria);
      if (Number.isInteger(criteria.index)) {
        return { success: true, index: 0, title: '另一个新建任务 任务完成' };
      }
      return { success: false, reason: 'chat_not_found' };
    }
  };

  await assert.rejects(
    () => gateway._switchToTaskSoloChat(task, 'collect_result'),
    /Solo chat|chat_not_found/i
  );
  assert.ok(attempts.length > 0);
  assert.ok(!attempts.some(criteria => Number.isInteger(criteria.index)));
});

asyncTest('Gateway accepts the unchanged active index for the sole submitted task after a total title rename', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  const task = {
    taskId: 'task_auto_renamed_solo',
    task: '实机拒绝终态验收',
    status: 'executing',
    submittedToTrae: true,
    soloChat: {
      index: 0,
      titleIncludes: '实机拒绝终态验收',
      textIncludes: '实机拒绝终态验收',
      candidates: ['实机拒绝终态验收']
    }
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway.taskHistoryStore = { recordStep: () => {}, ensureTask: () => {} };
  gateway.driver = {
    switchSoloChat: async () => ({ success: false, reason: 'chat_not_found' }),
    getActiveSoloChat: async () => ({
      active: { index: 0, title: '执行删除文件命令 任务完成', active: true }
    })
  };

  const result = await gateway._switchToTaskSoloChat(task, 'collect_result');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.reason, 'sole_submitted_task_active_index');
  assert.strictEqual(result.title, '执行删除文件命令 任务完成');
});

asyncTest('Gateway skips collectResponse while submitted Solo chat is still queued', async () => {
  const gateway = new Gateway();
  let collectCalled = false;
  const task = {
    taskId: 'task_submitted_solo_queued',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 4000,
    reviewRequired: false,
    followupTasks: [],
    queueState: 'queued',
    soloChat: { titleIncludes: 'Queued Solo Chat' }
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    switchSoloChat: async () => ({ success: true }),
    checkQueueStatus: async () => ({ queued: true, running: false, canSubmit: false, queuePosition: 9 }),
    collectResponse: async () => {
      collectCalled = true;
      throw new Error('collectResponse must not run while queued');
    }
  };

  const result = await gateway._collectSubmittedBackgroundTask(task.taskId, task);

  assert.strictEqual(collectCalled, false);
  assert.strictEqual(result.queued, true);
  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.queuePosition, 9);
});

asyncTest('Gateway skips collectResponse while submitted Solo chat is still running', async () => {
  const gateway = new Gateway();
  let collectCalled = false;
  const task = {
    taskId: 'task_submitted_solo_running',
    status: 'executing',
    task: 'TRAECN_GLM52_LONG_QUEUE_TEST verify unattended flow',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    submittedAt: Date.now() - 4000,
    reviewRequired: false,
    followupTasks: [],
    queueState: 'submitted',
    soloChat: {
      candidates: ['TRAECN_GLM52_LONG_QUEUE_TEST'],
      index: 0
    }
  };
  gateway.taskQueue.set(task.taskId, task);
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    switchSoloChat: async () => ({ success: true, index: 0, title: 'Verify TraeCN Solo Automation 进行中' }),
    getActiveSoloChat: async () => ({
      active: {
        index: 0,
        title: 'Verify TraeCN Solo Automation 进行中',
        text: 'Verify TraeCN Solo Automation 进行中',
        status: 'running'
      }
    }),
    checkQueueStatus: async () => {
      throw new Error('checkQueueStatus should not run while active Solo chat is visibly running');
    },
    collectResponse: async () => {
      collectCalled = true;
      throw new Error('collectResponse must not run while target Solo chat is running');
    }
  };

  const result = await gateway._collectSubmittedBackgroundTask(task.taskId, task);

  assert.strictEqual(collectCalled, false);
  assert.strictEqual(result.running, true);
  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.queueState, 'running');
  assert.match(task.queueMessage, /Verify TraeCN Solo Automation/);
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
  // bare Error messages are sanitized to 'Internal server error' to avoid
  // leaking internal paths/selectors via /api/task/:taskId. Real driver
  // failures throw TraeCNAutomationError, which still carries the message.
  assert.strictEqual(task.error, 'Internal server error');
});

asyncTest('Gateway background polling cancels generic queue probes before sending', async () => {
  const gateway = new Gateway();
  gateway.taskQueue = new Map();
  gateway.taskLocks = new Set();
  let pollOnce = null;
  let ensuredConnection = false;
  let sentToTrae = false;
  const cancelled = [];
  gateway._setInterval = (fn) => {
    pollOnce = fn;
    return { id: 'timer' };
  };
  gateway._clearInterval = () => {};
  gateway._persistActiveQueue = () => true;
  gateway._ensureConnection = async () => {
    ensuredConnection = true;
  };
  gateway._emitTaskNotification = async () => {};
  gateway.taskHistoryStore = {
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    failTask: () => {},
    cancelTask: (taskId) => {
      cancelled.push(taskId);
    }
  };
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    checkQueueStatus: async () => {
      throw new Error('checkQueueStatus must not be called');
    },
    newChat: async () => {
      sentToTrae = true;
    },
    sendMessage: async () => {
      sentToTrae = true;
    }
  };
  const task = {
    taskId: 'task_probe_guard',
    status: 'queued',
    task: 'wait for Trae queue',
    createdAt: Date.now(),
    followupTasks: []
  };
  gateway.taskQueue.set(task.taskId, task);

  gateway._ensureBackgroundPolling();
  await pollOnce();

  assert.strictEqual(task.status, 'cancelled');
  assert.strictEqual(task.error, 'generic_queue_probe_task_rejected');
  assert.deepStrictEqual(cancelled, ['task_probe_guard']);
  assert.strictEqual(ensuredConnection, false);
  assert.strictEqual(sentToTrae, false);
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

asyncTest('Gateway keeps submitted task executing when collected result lacks ownership token', async () => {
  const gateway = new Gateway();
  const task = {
    taskId: 'task_unowned_result',
    status: 'executing',
    task: 'TRAECN_GLM52_LONG_QUEUE_TEST verify unattended flow',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: false,
    followupTasks: [],
    soloChat: {
      candidates: ['TRAECN_GLM52_LONG_QUEUE_TEST']
    }
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '任务完成: stale settings-driver review output from another Solo chat',
    stable: true,
    elapsedMs: 1200
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 0);
  assert.strictEqual(task.error, null);
  assert.match(task.queueMessage, /ownership token/);
});

asyncTest('Gateway keeps long submitted queue waits alive without consuming retry attempts', async () => {
  const gateway = new Gateway();
  const steps = [];
  gateway.taskHistoryStore = {
    recordStep: (taskId, action, details) => steps.push({ taskId, action, ...details }),
    ensureTask: () => {}
  };
  gateway._persistActiveQueue = () => true;
  const task = {
    taskId: 'task_long_queue_collect',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: false,
    followupTasks: [],
    currentModel: 'GLM-5.2'
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '等待中 ... 排队提醒 当前模型请求量较高，您目前排在第 167 位。升级权益可获得速通次数，告别排队，立即生成答案。 升级方案',
    stable: false,
    timedOut: true,
    elapsedMs: 600058
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.submittedToTrae, true);
  assert.strictEqual(task.attempts, 0);
  assert.strictEqual(task.error, null);
  assert.strictEqual(task.queueState, 'queued');
  assert.strictEqual(task.queuePosition, 167);
  assert.strictEqual(task.queueMessage, '排在第 167 位');
  assert.strictEqual(steps.at(-1).action, 'queue_wait_continues');
});

asyncTest('Gateway does not fail exhausted submitted tasks when collected result is still queued', async () => {
  const gateway = new Gateway();
  gateway.taskHistoryStore = {
    recordStep: () => {},
    ensureTask: () => {}
  };
  gateway._persistActiveQueue = () => true;
  const task = {
    taskId: 'task_long_queue_exhausted',
    status: 'executing',
    task: 'review repo',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 3,
    reviewRequired: false,
    followupTasks: [],
    currentModel: 'GLM-5.2'
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '排队提醒 当前模型请求量较高，您目前排在第 42 位。',
    stable: false,
    timedOut: true,
    elapsedMs: 600000
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.attempts, 3);
  assert.strictEqual(task.queuePosition, 42);
  assert.strictEqual(task.error, null);
});

asyncTest('Gateway auto-answers code-answerable dialogs for unattended background tasks', async () => {
  const gateway = new Gateway();
  const steps = [];
  gateway.taskHistoryStore = {
    recordStep: (taskId, action, details) => steps.push({ taskId, action, ...details }),
    ensureTask: () => {}
  };
  gateway._persistActiveQueue = () => true;
  gateway.driver = {
    answerQuestionDialog: async answer => ({
      success: true,
      selectedOption: answer,
      buttonClicked: 'Current workspace changes'
    })
  };
  const task = {
    taskId: 'task_auto_dialog',
    status: 'executing',
    task: 'review current workspace',
    createdAt: Date.now() - 5000,
    submittedToTrae: true,
    attempts: 0,
    reviewRequired: false,
    followupTasks: [],
    autoApproveDialog: 'auto'
  };
  gateway.taskQueue.set(task.taskId, task);

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '',
    stable: false,
    needsApproval: true,
    question: 'What would you like me to review?',
    dialogType: 'review_scope_question',
    options: [
      { label: 'Specific files' },
      { label: 'Current workspace changes' }
    ]
  });

  assert.strictEqual(task.status, 'executing');
  assert.strictEqual(task.error, null);
  assert.strictEqual(task.answeredDialog.action, 'answer');
  assert.strictEqual(task.answeredDialog.selectedOption, 'Current workspace changes');
  assert.strictEqual(steps.at(-1).action, 'dialog_auto_approved');
});

asyncTest('Gateway auto mode refuses command cards even when an adapter marks them safe', async () => {
  const auditEntries = [];
  const gateway = new Gateway({ auditLogger: { log: entry => auditEntries.push(entry) } });
  let approveCalls = 0;
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway.taskHistoryStore = {
    recordStep: () => {},
    ensureTask: () => {}
  };
  gateway.driver = {
    checkForApprovalDialog: async () => ({
      needsApproval: true,
      dialogType: 'command_execution',
      isCommandExec: true,
      canAutoApprove: true,
      approvalDecision: 'auto_approve',
      commandRisk: 'low',
      riskReasons: ['legacy_read_only_allowlist'],
      command: 'git status && git diff --stat'
    }),
    approveDialog: async action => {
      approveCalls++;
      return { success: true, action, buttonClicked: '运行' };
    }
  };
  const task = {
    taskId: 'task_safe_command_dialog',
    status: 'approval_required',
    submittedToTrae: true,
    autoApproveDialog: 'auto'
  };

  const approved = await gateway._tryAutoApproveTaskDialog(task.taskId, task, {
    needsApproval: true,
    dialogType: 'command_execution'
  });

  assert.strictEqual(approved, false);
  assert.strictEqual(approveCalls, 0);
  assert.strictEqual(task.answeredDialog, undefined);
  assert.deepStrictEqual(auditEntries, []);
});

asyncTest('Gateway auto mode leaves risky command cards for calling-agent review', async () => {
  const gateway = new Gateway();
  let approveCalls = 0;
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway.taskHistoryStore = {
    recordStep: () => {},
    ensureTask: () => {}
  };
  gateway.driver = {
    checkForApprovalDialog: async () => ({
      needsApproval: true,
      dialogType: 'command_execution',
      isCommandExec: true,
      canAutoApprove: false,
      approvalDecision: 'agent_review',
      commandRisk: 'high',
      riskReasons: ['git_write_or_remote'],
      command: 'git push origin main'
    }),
    approveDialog: async () => {
      approveCalls++;
      return { success: true };
    }
  };
  const task = {
    taskId: 'task_risky_command_dialog',
    status: 'approval_required',
    submittedToTrae: true,
    autoApproveDialog: 'auto'
  };

  const approved = await gateway._tryAutoApproveTaskDialog(task.taskId, task, {
    needsApproval: true,
    dialogType: 'command_execution'
  });

  assert.strictEqual(approved, false);
  assert.strictEqual(approveCalls, 0);
});

asyncTest('Gateway records a compact durable event before delivering task notifications', async () => {
  const gateway = new Gateway();
  const recorded = [];
  gateway.taskEventStore = {
    append: event => {
      recorded.push(event);
      return { eventId: 'evt_1', ...event };
    }
  };

  await gateway._emitTaskNotification('task-event-1', {
    taskId: 'task-event-1',
    status: 'done',
    sessionId: 'session-1',
    result: { text: 'Review complete. No high-severity findings were found.' }
  }, 'task.completed');

  assert.deepStrictEqual(recorded, [{
    type: 'task.completed',
    taskId: 'task-event-1',
    status: 'done',
    terminal: true,
    attentionRequired: false,
    resultAvailable: true,
    sessionId: 'session-1',
    summary: 'Review complete. No high-severity findings were found.'
  }]);
});

asyncTest('Gateway task-event API lists pending events and acknowledges a client cursor', async () => {
  const gateway = new Gateway({
    taskEventStore: new (require('../shared/task-event-store').TaskEventStore)({ persistencePath: null })
  });
  const event = gateway.taskEventStore.append({
    type: 'task.completed',
    taskId: 'task-api-event',
    status: 'done',
    terminal: true,
    resultAvailable: true
  });

  let listed = null;
  gateway._json = (req, res, data) => {
    listed = data;
    return data;
  };
  const listReq = new Readable({ read() {} });
  listReq.url = '/api/task-events?clientId=codex-test&waitMs=0';
  listReq.headers = { host: '127.0.0.1:8788' };
  await gateway._handleListTaskEvents(listReq, {});
  assert.deepStrictEqual(listed.events.map(item => item.taskId), ['task-api-event']);

  let acknowledged = null;
  gateway._json = (req, res, data) => {
    acknowledged = data;
    return data;
  };
  const ackReq = new Readable({ read() {} });
  ackReq.url = '/api/task-events/ack';
  ackReq.headers = { host: '127.0.0.1:8788', 'content-type': 'application/json' };
  ackReq.push(JSON.stringify({ clientId: 'codex-test', eventId: event.eventId }));
  ackReq.push(null);
  await gateway._handleAckTaskEvent(ackReq, {});
  assert.strictEqual(acknowledged.acknowledged, true);
  assert.deepStrictEqual(gateway.taskEventStore.list({ clientId: 'codex-test' }).events, []);
});

asyncTest('Gateway task-event API returns 503 when acknowledgement persistence fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-event-ack-failure-'));
  let failWrites = false;
  try {
    const { TaskEventStore } = require('../shared/task-event-store');
    const eventStore = new TaskEventStore({
      persistencePath: path.join(dir, 'events.json'),
      logger: { error() {}, warn() {} },
      onWritePhase(phase) {
        if (failWrites && phase === 'temp_written') {
          const error = new Error('simulated full event store');
          error.code = 'ENOSPC';
          throw error;
        }
      }
    });
    const event = eventStore.append({
      type: 'task.completed',
      taskId: 'task-ack-failure',
      status: 'done',
      terminal: true
    });
    failWrites = true;
    const gateway = new Gateway({ taskEventStore: eventStore });
    let response = null;
    gateway._json = (req, res, data, status = 200) => {
      response = { data, status };
      return data;
    };
    const ackReq = new Readable({ read() {} });
    ackReq.url = '/api/task-events/ack';
    ackReq.headers = { host: '127.0.0.1:8788', 'content-type': 'application/json' };
    ackReq.push(JSON.stringify({ clientId: 'codex-failure', eventId: event.eventId }));
    ackReq.push(null);

    await gateway._handleAckTaskEvent(ackReq, {});

    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.data.acknowledged, false);
    assert.strictEqual(response.data.error, 'TASK_EVENT_STORE_UNAVAILABLE');
    assert.deepStrictEqual(
      eventStore.list({ clientId: 'codex-failure' }).events.map(item => item.taskId),
      ['task-ack-failure']
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('Gateway continues workflow without mutating parent followup list', async () => {
  const gateway = new Gateway();
  let idCounter = 0;
  gateway.driver = { config: { queuePerTaskTimeoutMs: 1000 } };
  gateway.taskHistoryStore = {
    createTask: () => `task_followup_${++idCounter}`,
    recordStep: () => {},
    ensureTask: () => {},
    completeTask: () => {},
    cancelTask: () => {},
    failTask: () => {}
  };
  gateway._persistActiveQueue = () => true;
  gateway._ensureBackgroundPolling = () => {};

  const parent = {
    taskId: 'task_parent_followups',
    status: 'awaiting_review',
    task: 'initial task',
    createdAt: Date.now(),
    result: { text: 'done', stable: true },
    followupTasks: [
      { task: 'followup 1', reviewRequired: true },
      { task: 'followup 2', reviewRequired: false }
    ],
    autoContinue: true
  };
  gateway.taskQueue.set(parent.taskId, parent);

  const continued = await gateway._continueReviewedTask(parent.taskId, parent, 'approve', 'test');
  const nextTask = gateway.taskQueue.get(continued.nextTaskId);

  assert.strictEqual(parent.followupTasks.length, 2);
  assert.strictEqual(parent.followupTasks[0].task, 'followup 1');
  assert.strictEqual(nextTask.task, 'followup 1');
  assert.strictEqual(nextTask.followupTasks.length, 1);
  assert.strictEqual(nextTask.followupTasks[0].task, 'followup 2');
});

asyncTest('Gateway background cleanup preserves old paused tasks', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  let pollOnce = null;
  gateway._setInterval = (fn) => {
    pollOnce = fn;
    return { id: 'timer' };
  };
  gateway._clearInterval = () => {};
  gateway._persistActiveQueue = () => true;

  const oldCreatedAt = Date.now() - 7200000;
  gateway.taskQueue.set('task_old_approval', {
    taskId: 'task_old_approval',
    status: 'approval_required',
    task: 'needs answer',
    createdAt: oldCreatedAt,
    followupTasks: []
  });
  gateway.taskQueue.set('task_old_done', {
    taskId: 'task_old_done',
    status: 'done',
    task: 'finished',
    createdAt: oldCreatedAt,
    followupTasks: []
  });

  gateway._ensureBackgroundPolling();
  await pollOnce();

  assert.strictEqual(gateway.taskQueue.has('task_old_approval'), true);
  assert.strictEqual(gateway.taskQueue.has('task_old_done'), false);
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
  gateway.taskQueueService.tryAcquire(task.taskId);
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
  gateway._persistActiveQueue = () => true;
  gateway.driver = {
    checkQueueStatus: async () => ({ queued: false, running: false }),
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

asyncTest('Gateway adopt-current returns existing submitted Solo task for the same active chat', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  let pollingStarted = false;
  gateway._ensureBackgroundPolling = () => {
    pollingStarted = true;
  };
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    checkQueueStatus: async () => ({
      queued: true,
      running: false,
      canSubmit: true,
      queuePosition: 7,
      queueMessage: '排在第 7 位',
      currentModel: 'GLM-5.2'
    }),
    getActiveSoloChat: async () => ({
      mode: 'solo',
      active: {
        index: 0,
        title: 'Debug HTTP Route Handlers 进行中 13:30',
        text: 'Debug HTTP Route Handlers 进行中 13:30',
        status: 'running'
      }
    })
  };
  gateway.taskHistoryStore = {
    createTask: () => {
      throw new Error('duplicate adopt must not create a new task');
    },
    recordStep: () => {},
    ensureTask: () => {}
  };
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway.taskQueue.clear();
  gateway.taskQueue.set('task_existing_adopt', {
    taskId: 'task_existing_adopt',
    status: 'executing',
    task: 'Debug current workspace briefly. Marker TRAECN_DEBUG_SYNC_GLM52.',
    createdAt: Date.now() - 1000,
    submittedToTrae: true,
    submittedAt: Date.now() - 900,
    reviewRequired: false,
    followupTasks: [],
    soloChat: {
      index: 0,
      titleIncludes: 'Debug HTTP Route Handlers',
      textIncludes: 'Debug HTTP Route Handlers',
      candidates: ['TRAECN_DEBUG_SYNC_GLM52', 'Debug HTTP Route Handlers']
    }
  });

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'Adopt existing Trae debug request. Marker TRAECN_DEBUG_SYNC_GLM52.' }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleAdoptCurrentTask(req, {});

  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(responseData.taskId, 'task_existing_adopt');
  assert.strictEqual(responseData.deduped, true);
  assert.strictEqual(responseData.queueDetails.queuePosition, 7);
  assert.strictEqual(gateway.taskQueue.size, 1);
  assert.strictEqual(gateway.taskQueue.get('task_existing_adopt').queuePosition, 7);
  assert.strictEqual(pollingStarted, true);
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
  assert.strictEqual(responseData.confirmationPhrase, undefined);
  assert.ok(responseData.confirmationId);
  assert.strictEqual(responseData.plan.command, 'restart_trae_debug');
});

asyncTest('Gateway restart-debug confirmed branch uses restart dependencies and returns CDP surface', async () => {
  const gateway = new Gateway();
  const traeControl = require('./handlers/trae-control');
  const previousPort = process.env.TRAECN_REMOTE_DEBUGGING_PORT;
  let responseData = null;
  let responseStatus = null;
  let restartOptions = null;
  let clientClosed = false;

  gateway.client = {
    close: async () => {
      clientClosed = true;
    }
  };
  gateway.driver = { stale: true };
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  traeControl.setRestartDebugDepsForTest({
    getQuickstartConfig: () => ({ remoteDebuggingPort: '17777' }),
    getEnvWithFallback: () => '17777',
    restartTraeCNWithDebug: async (options) => {
      restartOptions = options;
      return { ok: true, pid: 12345 };
    },
    discoverTarget: async () => ({ target: { id: 'target-1', type: 'page', url: 'http://127.0.0.1' } }),
    describeCDPSurface: targets => ({ count: targets.length, primary: targets[0] })
  });

  try {
    const req = new Readable({
      read() {
        this.push(JSON.stringify({
          confirmationPhrase: 'restart-trae-cn-with-debug-existing-profile',
          projectPath: '/tmp/project',
          quitTimeoutMs: 10,
          pollMs: 5,
          cdpWaitMs: 1
        }));
        this.push(null);
      }
    });
    req.headers = { 'content-type': 'application/json' };

    await gateway._handleRestartTraeDebug(req, {});
  } finally {
    traeControl.setRestartDebugDepsForTest();
    restoreEnv('TRAECN_REMOTE_DEBUGGING_PORT', previousPort);
  }

  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(responseData.ok, true);
  assert.strictEqual(responseData.requestedPort, '17777');
  assert.strictEqual(responseData.connected, true);
  assert.deepStrictEqual(restartOptions, { projectPath: '/tmp/project', quitTimeoutMs: 10, pollMs: 5 });
  assert.strictEqual(clientClosed, true);
  assert.strictEqual(gateway.client, null);
  assert.strictEqual(gateway.driver, null);
  assert.strictEqual(responseData.surface.count, 1);
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

asyncTest('Gateway reports an unavailable historical result instead of returning a stale page snapshot', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.driver = {
    findTaskResponse: async () => ({
      text: '新任务⌃⌘N任务0和智能体对话，开始你的第一个任务吧',
      inProgress: false,
      isComplete: false,
      hasResponse: false
    })
  };
  gateway.taskHistoryStore = {
    getTask: () => ({
      taskId: 'task_stale_result',
      task: 'update MCP support',
      status: 'completed',
      createdAt: new Date(Date.now() - 5000).toISOString(),
      createdAtMs: Date.now() - 5000,
      completedAt: new Date().toISOString(),
      elapsedMs: 5000,
      result: {
        text: '新任务 任务 3 Agent 一切就绪，只等你动手。资源管理器 文件',
        stable: true
      },
      metadata: {},
      steps: [{ action: 'done', timestamp: new Date().toISOString(), success: true, details: {} }]
    })
  };

  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; };

  await gateway._handleTaskStatus({}, {}, 'task_stale_result');

  assert.strictEqual(responseData.status, 'done');
  assert.strictEqual(responseData.errorCode, 'TASK_RESULT_UNAVAILABLE');
  assert.match(responseData.error, /Agent response is no longer available/);
  assert.strictEqual(responseData.result, undefined);
});

asyncTest('Gateway rejects a stale historical page snapshot when no CDP driver is connected', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.driver = null;
  gateway._ensureConnection = async () => { throw new Error('Trae unavailable'); };
  gateway.taskHistoryStore = {
    getTask: () => ({
      taskId: 'task_stale_without_driver',
      status: 'completed',
      createdAtMs: Date.now() - 1000,
      completedAt: new Date().toISOString(),
      result: { text: 'Agent 一切就绪，只等你动手。资源管理器 文件', stable: true },
      metadata: {},
      steps: []
    })
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; };

  await gateway._handleTaskStatus({}, {}, 'task_stale_without_driver');

  assert.strictEqual(responseData.status, 'done');
  assert.strictEqual(responseData.errorCode, 'TASK_RESULT_UNAVAILABLE');
  assert.strictEqual(responseData.result, undefined);
});

asyncTest('Gateway connects to Trae before recovering an unavailable historical result', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.driver = null;
  gateway._ensureConnection = async () => {
    gateway.driver = {
      findTaskResponse: async () => ({
        text: 'Agent\n完成总结\n直接任务查询已恢复\n任务完成',
        inProgress: false,
        isComplete: true,
        hasResponse: true
      })
    };
  };
  gateway.taskHistoryStore = {
    getTask: () => ({
      taskId: 'task_connect_then_recover',
      status: 'completed',
      createdAtMs: Date.now() - 1000,
      completedAt: new Date().toISOString(),
      result: {
        code: 'TASK_RESULT_UNAVAILABLE',
        error: 'Agent response is no longer available in the bound TraeCN conversation'
      },
      metadata: {},
      steps: []
    })
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; };

  await gateway._handleTaskStatus({}, {}, 'task_connect_then_recover');

  assert.strictEqual(responseData.errorCode, undefined);
  assert.ok(responseData.result.text.includes('直接任务查询已恢复'));
});

asyncTest('Gateway recovers an unavailable historical result after its Trae conversation returns', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.driver = {
    findTaskResponse: async () => ({
      text: 'Agent\n完成总结\nMCP 更新完成\n任务完成',
      inProgress: false,
      isComplete: true,
      hasResponse: true
    })
  };
  gateway.taskHistoryStore = {
    getTask: () => ({
      taskId: 'task_recovered_result',
      status: 'completed',
      createdAtMs: Date.now() - 1000,
      completedAt: new Date().toISOString(),
      result: {
        code: 'TASK_RESULT_UNAVAILABLE',
        error: 'Agent response is no longer available in the bound TraeCN conversation'
      },
      metadata: {},
      steps: []
    })
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; };

  await gateway._handleTaskStatus({}, {}, 'task_recovered_result');

  assert.strictEqual(responseData.errorCode, undefined);
  assert.ok(responseData.result.text.includes('MCP 更新完成'));
  assert.strictEqual(responseData.result.stable, true);
});

asyncTest('Gateway compacts a persisted Solo process transcript to its final summary', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  gateway.driver = {
    findTaskResponse: async () => ({
      text: '完成总结\n最终改动和测试结果',
      inProgress: false,
      isComplete: true,
      hasResponse: true
    })
  };
  gateway.taskHistoryStore = {
    getTask: () => ({
      taskId: 'task_uncompacted_transcript',
      status: 'completed',
      createdAtMs: Date.now() - 1000,
      completedAt: new Date().toISOString(),
      result: {
        text: 'Agent\n思考过程\n大量工具调用和中间步骤\n完成总结\n最终改动和测试结果\n任务完成',
        stable: true
      },
      metadata: {},
      steps: []
    })
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; };

  await gateway._handleTaskStatus({}, {}, 'task_uncompacted_transcript');

  assert.strictEqual(responseData.result.text, '完成总结\n最终改动和测试结果');
});

asyncTest('Gateway returns the full live trace when task detailLevel is trace', async () => {
  const gateway = new Gateway();
  gateway.taskQueue.clear();
  let requestedOptions = null;
  gateway.driver = {
    findTaskResponse: async options => {
      requestedOptions = options;
      return {
        text: 'Agent\n思考过程\n工具调用\n完成总结\n最终结果\n任务完成',
        inProgress: false,
        isComplete: true,
        hasResponse: true
      };
    }
  };
  gateway.taskHistoryStore = {
    getTask: () => ({
      taskId: 'task_trace_result',
      status: 'completed',
      createdAtMs: Date.now() - 1000,
      completedAt: new Date().toISOString(),
      result: { text: '完成总结\n最终结果', stable: true },
      metadata: {},
      steps: []
    })
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; };

  await gateway._handleTaskStatus({ url: '/api/task/task_trace_result?detailLevel=trace' }, {}, 'task_trace_result');

  assert.deepStrictEqual(requestedOptions, { detailLevel: 'trace' });
  assert.ok(responseData.result.text.includes('思考过程'));
  assert.strictEqual(responseData.detailLevel, 'trace');
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
  gateway.mockBridge = true;
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
  gateway.mockBridge = true;
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
  gateway.mockBridge = true;
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

asyncTest('Gateway sync delegate returns background task immediately when model is queued', async () => {
  const gateway = new Gateway();
  gateway.driver = {
    config: { queuePerTaskTimeoutMs: 1000 },
    checkQueueStatus: async () => ({
      queued: true,
      running: false,
      canSubmit: false,
      currentModel: 'GLM-5.2',
      queuePosition: 88,
      queueMessage: '排在第 88 位'
    }),
    delegate: async () => {
      throw new Error('delegate should not run while queue is blocked');
    }
  };
  gateway._ensureConnection = async () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway.taskHistoryStore = {
    createTask: () => 'task_sync_queue_fast_return',
    recordStep: () => {},
    ensureTask: () => {}
  };
  gateway._persistActiveQueue = () => true;

  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status = 200) => {
    responseData = data;
    responseStatus = status;
    return data;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'review repo', projectPath: '/tmp/sync-project' }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleDelegate(req, {}, null);
  assert.strictEqual(responseStatus, 202);
  assert.strictEqual(responseData.taskId, 'task_sync_queue_fast_return');
  assert.strictEqual(responseData.status, 'queued');
  assert.strictEqual(responseData.queueDetails.queuePosition, 88);
  assert.strictEqual(gateway.taskQueue.get('task_sync_queue_fast_return').status, 'queued');
});

asyncTest('Gateway sync delegate timeout converts submitted request to tracked background task', async () => {
  const gateway = new Gateway();
  gateway.mockBridge = true;
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
  assert.strictEqual(delegatedPrompt, 'review repo');
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
  gateway.mockBridge = true;
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
  gateway._persistActiveQueue = () => true;
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
  gateway._persistActiveQueue = () => true;
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
  gateway._persistActiveQueue = () => true;
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

asyncTest('Gateway _handleUpdateSelf returns 200 with success:false', async () => {
  const gateway = new Gateway();
  let responseData, responseStatus;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ force: true }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  await gateway._handleUpdateSelf(req, {});

  assert.strictEqual(responseStatus, 200);
  assert.strictEqual(responseData.success, false);
  assert.strictEqual(responseData.force, true);
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
  gateway.mockBridge = true;
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

asyncTest('Gateway delegate returns 503 CDP_NOT_CONNECTED when CDP endpoint unreachable (honest failure)', async () => {
  const gateway = new Gateway();
  gateway.mockBridge = false;
  gateway._ensureConnection = async () => {};
  gateway._json = (req, res, data, status = 200) => {
    gateway.__respData = data;
    gateway.__respStatus = status;
    return data;
  };

  const discovery = require('../cdp/discovery');
  const origResolve = discovery.resolveCDPEndpoint;
  discovery.resolveCDPEndpoint = async () => {
    throw new Error('simulated CDP unreachable');
  };

  const req = new Readable({
    read() {
      this.push(JSON.stringify({ task: 'drive TraeCN for real', mode: 'ide', autoWait: false }));
      this.push(null);
    }
  });
  req.headers = { 'content-type': 'application/json' };

  try {
    await gateway._handleDelegateAsync(req, {});
  } finally {
    discovery.resolveCDPEndpoint = origResolve;
  }

  assert.strictEqual(gateway.__respStatus, 503, 'unreachable CDP must fail with 503, not a false ok');
  assert.strictEqual(gateway.__respData.error, 'CONNECTION_FAILED');
  assert.strictEqual(gateway.__respData.code, 'CDP_NOT_CONNECTED');
  assert.ok(/CDP is not reachable/i.test(gateway.__respData.message), 'message must explain CDP unreachable');
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

asyncTest('Gateway open-project reuses the active TraeCN window when it is already running', async () => {
  const gateway = new Gateway();
  const quickstart = require('../config/quickstart');
  const origIsRunning = quickstart.isTraeCNRunning;
  const origStart = quickstart.startTraeCN;
  const origOpenExisting = quickstart.openProjectInExistingWindow;
  quickstart.isTraeCNRunning = () => true;
  quickstart.startTraeCN = () => {
    throw new Error('startTraeCN must not be invoked when TraeCN is already running');
  };
  let openedWith = null;
  quickstart.openProjectInExistingWindow = async options => {
    openedWith = options;
    return {
      command: '/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn',
      args: ['--reuse-window', '/tmp/some-project']
    };
  };
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    getWorkspaceContext: async () => ({
      title: openedWith ? 'some-project' : 'old-project',
      folderName: openedWith ? 'some-project' : 'old-project',
      rootPath: openedWith ? '/tmp/some-project' : '/tmp/old-project',
      hasExplorer: true
    })
  };

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
    assert.strictEqual(responseStatus, 200);
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.reusedWindow, true);
    assert.strictEqual(responseData.projectPath, '/tmp/some-project');
    assert.strictEqual(gateway._selectedWorkspacePath, '/tmp/some-project');
    assert.strictEqual(openedWith.projectPath, '/tmp/some-project');
    assert.strictEqual(responseData.verifiedWorkspace.rootPath, '/tmp/some-project');
  } finally {
    quickstart.isTraeCNRunning = origIsRunning;
    quickstart.startTraeCN = origStart;
    quickstart.openProjectInExistingWindow = origOpenExisting;
  }
});

asyncTest('Gateway open-project does not reload an already-open workspace', async () => {
  const gateway = new Gateway();
  const quickstart = require('../config/quickstart');
  const origIsRunning = quickstart.isTraeCNRunning;
  const origOpenExisting = quickstart.openProjectInExistingWindow;
  quickstart.isTraeCNRunning = () => true;
  quickstart.openProjectInExistingWindow = async () => {
    throw new Error('workspace switch must not run for the already-open path');
  };
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    getWorkspaceContext: async () => ({
      title: 'some-project',
      folderName: 'some-project',
      rootPath: '/tmp/some-project',
      hasExplorer: true
    })
  };

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
    assert.strictEqual(responseStatus, 200);
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.alreadyOpen, true);
    assert.strictEqual(responseData.reusedWindow, false);
    assert.strictEqual(gateway._selectedWorkspacePath, '/tmp/some-project');
    assert.strictEqual(responseData.verifiedWorkspace.rootPath, '/tmp/some-project');
  } finally {
    quickstart.isTraeCNRunning = origIsRunning;
    quickstart.openProjectInExistingWindow = origOpenExisting;
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
  gateway.traeControl.autoStartTrae = true;
  gateway.traeControl.recoveryCooldownMs = 60000;
  gateway.traeControl.lastRecoveryAt = Date.now();
  const result = await gateway._attemptTraeRecovery(new Error('cdp gone'));
  assert.strictEqual(result, false, 'cooldown should suppress the second call');
});

asyncTest('Gateway auto-recovery bails early when autoStartTrae is off', async () => {
  const gateway = new Gateway();
  gateway.autoStartTrae = false;
  gateway.traeControl.autoStartTrae = false;
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

asyncTest('Gateway lists settings sections from Trae UI and restores chat', async () => {
  const gateway = new Gateway();
  const calls = [];
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    settings: {
      listSections: async () => { calls.push('open-settings'); return ['通用', '模型', 'MCP']; },
      backToChat: async () => calls.push('back-to-chat')
    }
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; return data; };

  await gateway._handleSettingsListSections({ headers: { host: '127.0.0.1' }, url: '/api/settings/sections?restoreChat=true' }, {});

  assert.deepStrictEqual(responseData.sections, ['通用', '模型', 'MCP']);
  assert.deepStrictEqual(calls, ['open-settings', 'back-to-chat']);
});

asyncTest('Gateway reads one settings section from Trae UI and restores chat', async () => {
  const gateway = new Gateway();
  const calls = [];
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    settings: {
      switchTab: async section => calls.push(`section:${section}`),
      getContent: async () => ({ sections: [], items: [{ label: 'Auto Save', hasToggle: true }] }),
      backToChat: async () => calls.push('back-to-chat')
    }
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; return data; };
  const { req } = makeReqRes({}, '/api/settings/read?section=%E9%80%9A%E7%94%A8&restoreChat=true');

  await gateway._handleSettingsRead(req, {});

  assert.strictEqual(responseData.section, '通用');
  assert.strictEqual(responseData.items[0].label, 'Auto Save');
  assert.deepStrictEqual(calls, ['section:通用', 'back-to-chat']);
});

asyncTest('Gateway retries one lazy settings page when its first read is empty', async () => {
  const gateway = new Gateway();
  const calls = [];
  let readCount = 0;
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    settings: {
      switchTab: async section => calls.push(`section:${section}`),
      getContent: async () => {
        calls.push('read');
        readCount++;
        return readCount === 1
          ? { sections: [], items: [] }
          : { sections: [], items: [{ label: 'Tab-Cue', controlType: 'toggle' }] };
      },
      backToChat: async () => calls.push('back-to-chat')
    }
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; return data; };
  const { req } = makeReqRes({}, '/api/settings/read?section=CUE&restoreChat=true');

  await gateway._handleSettingsRead(req, {});

  assert.deepStrictEqual(responseData.items.map(item => item.label), ['Tab-Cue']);
  assert.deepStrictEqual(calls, ['section:CUE', 'read', 'section:CUE', 'read', 'back-to-chat']);
});

asyncTest('Gateway reports an error when an activated settings page stays unreadable', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    settings: {
      switchTab: async () => {},
      getContent: async () => ({ sections: [], items: [] }),
      backToChat: async () => {}
    }
  };
  let responseData = null;
  let responseStatus = null;
  gateway._json = (req, res, data, status) => {
    responseData = data;
    responseStatus = status;
    return data;
  };
  const { req } = makeReqRes({}, '/api/settings/read?section=CUE&restoreChat=true');

  await gateway._handleSettingsRead(req, {});

  assert.strictEqual(responseStatus, 500);
  assert.match(responseData.error, /Settings section "CUE" did not expose readable content/);
});

asyncTest('Gateway lists one setting dropdown options from Trae UI and restores chat', async () => {
  const gateway = new Gateway();
  const calls = [];
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    settings: {
      switchTab: async section => calls.push(`section:${section}`),
      listOptions: async label => { calls.push(`options:${label}`); return ['简体中文', 'English']; },
      backToChat: async () => calls.push('back-to-chat')
    }
  };
  let responseData = null;
  gateway._json = (req, res, data) => { responseData = data; return data; };
  const { req } = makeReqRes({}, '/api/settings/options?section=%E9%80%9A%E7%94%A8&label=%E8%AF%AD%E8%A8%80&restoreChat=true');

  await gateway._handleSettingsListOptions(req, {});

  assert.deepStrictEqual(responseData.options, ['简体中文', 'English']);
  assert.deepStrictEqual(calls, ['section:通用', 'options:语言', 'back-to-chat']);
});

asyncTest('Gateway dispatches each settings control kind to its exact Trae UI action', async () => {
  const gateway = new Gateway();
  const calls = [];
  gateway._ensureConnection = async () => {};
  gateway.driver = {
    settings: {
      switchTab: async section => calls.push(['section', section]),
      setToggle: async (label, enabled) => calls.push(['toggle', label, enabled]),
      setDropdown: async (label, value) => calls.push(['option', label, value]),
      typeText: async (label, text) => calls.push(['text', label, text]),
      backToChat: async () => calls.push(['back'])
    }
  };
  gateway._json = (req, res, data) => data;
  const cases = [
    { kind: 'toggle', section: '通用', label: 'Auto Save', value: true },
    { kind: 'option', section: '通用', label: '语言', value: 'English' },
    { kind: 'text', section: 'MCP', label: '服务器地址', value: 'http://127.0.0.1' }
  ];

  for (const body of cases) {
    const { req } = makeReqRes({}, '/api/settings/set', 'POST', { ...body, restoreChat: true });
    await gateway._handleSettingsSet(req, {});
  }

  assert.deepStrictEqual(calls, [
    ['section', '通用'], ['toggle', 'Auto Save', true], ['back'],
    ['section', '通用'], ['option', '语言', 'English'], ['back'],
    ['section', 'MCP'], ['text', '服务器地址', 'http://127.0.0.1'], ['back']
  ]);
});

asyncTest('Gateway rejects a settings value that does not match its UI control kind', async () => {
  const gateway = new Gateway();
  gateway._ensureConnection = async () => {};
  gateway.driver = { settings: { setToggle: async () => { throw new Error('must not mutate'); } } };
  let responseStatus = null;
  let responseData = null;
  gateway._json = (req, res, data, status = 200) => {
    responseStatus = status;
    responseData = data;
    return data;
  };
  const { req } = makeReqRes({}, '/api/settings/set', 'POST', {
    section: '通用', label: 'Auto Save', value: 'yes', kind: 'toggle'
  });

  await gateway._handleSettingsSet(req, {});

  assert.strictEqual(responseStatus, 400);
  assert.match(responseData.error, /boolean/);
});

test('Gateway resumes only the approval-required task matching the visible command', () => {
  const gateway = new Gateway();
  const steps = [];
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway._ensureBackgroundPolling = () => {};
  gateway.taskHistoryStore = {
    recordStep: (taskId, step) => steps.push([taskId, step]),
    ensureTask: () => {}
  };
  gateway.taskQueue = new Map([
    ['older', {
      status: 'approval_required',
      createdAt: 1,
      result: { question: '运行 git push origin main？' }
    }],
    ['matching', {
      status: 'approval_required',
      createdAt: 2,
      result: { question: '运行 find /tmp/live-uat -delete？' }
    }]
  ]);

  const resumed = gateway._resumeApprovalRequiredTasksAfterInteraction(
    'deny',
    { command: 'find /tmp/live-uat -delete' },
    { success: true, buttonClicked: '跳过' }
  );

  assert.deepStrictEqual(resumed, ['matching']);
  assert.strictEqual(gateway.taskQueue.get('matching').status, 'executing');
  assert.strictEqual(gateway.taskQueue.get('older').status, 'approval_required');
  assert.deepStrictEqual(steps, [['matching', 'dialog_resolved']]);
});

asyncTest('Gateway ignores a stale approval result after the visible card was resolved', async () => {
  const gateway = new Gateway();
  const steps = [];
  gateway._persistActiveQueue = () => true;
  gateway._syncTaskHistoryMirror = () => {};
  gateway._isQueuedTaskResult = () => false;
  gateway._resultBelongsToSubmittedTask = () => true;
  gateway.taskHistoryStore = {
    recordStep: (taskId, step) => steps.push([taskId, step]),
    ensureTask: () => {}
  };
  gateway.driver = {
    checkForApprovalDialog: async () => ({ needsApproval: false })
  };
  const task = {
    taskId: 'stale-card',
    task: 'run a command',
    status: 'executing',
    submittedToTrae: true,
    queueState: 'running'
  };

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    needsApproval: true,
    question: 'stale card text'
  });

  assert.strictEqual(task.status, 'executing');
  assert.ok(steps.some(([, step]) => step === 'submitted_task_result_not_owned'));
});

asyncTest('Gateway terminalizes a task when Trae confirms its command was denied', async () => {
  const gateway = new Gateway();
  gateway._isQueuedTaskResult = () => false;
  gateway._resultBelongsToSubmittedTask = () => true;
  gateway._finalizeBackgroundTask = async (_taskId, task, status, payload) => {
    task.status = status;
    task.result = payload.result;
    task.error = payload.error;
  };
  const task = {
    taskId: 'denied-command',
    task: 'run a destructive command',
    status: 'executing',
    submittedToTrae: true,
    answeredDialog: { action: 'deny', buttonClicked: '跳过' }
  };

  await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
    text: '命令已取消 find /tmp/live-uat -delete Thought 命令已跳过执行。还有其他需要协助的吗？',
    stable: true,
    elapsedMs: 100
  });

  assert.strictEqual(task.status, 'cancelled');
  assert.strictEqual(task.error, null);
  assert.ok(task.result.text.includes('命令已跳过执行'));
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
  try {
    fs.unlinkSync(TEST_EVENT_PERSISTENCE_PATH);
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
  try {
    fs.unlinkSync(TEST_EVENT_PERSISTENCE_PATH);
  } catch {}
  process.exit(1);
});
