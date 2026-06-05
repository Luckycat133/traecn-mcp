'use strict';

const assert = require('assert');
const { Gateway, RateLimiter, sanitizeLog } = require('./gateway');
const { buildCapabilities } = require('../shared/capabilities');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');

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

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

console.log(`\n[gateway.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
