'use strict';

const assert = require('assert');
const {
  getEnvWithFallback,
  parseSelectors,
  parsePositiveInt,
  sleep,
  safeJsValue,
  isQueueProbeCommandText,
  isGenericQueueProbeTask,
  isForeignQueueProbeText,
  safeClose,
  sanitizeLog,
  getGatewayContext,
  SENSITIVE_LOG_KEYS
} = require('../shared/utils');

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

console.log('\n[utils.test.js] Running tests...\n');

test('getEnvWithFallback returns traecnKey value first', () => {
  process.env.TEST_TRAECN_KEY = 'traecn_value';
  delete process.env.TEST_TRAE_KEY;
  assert.strictEqual(getEnvWithFallback('TEST_TRAECN_KEY', 'TEST_TRAE_KEY', 'default'), 'traecn_value');
  delete process.env.TEST_TRAECN_KEY;
});

test('getEnvWithFallback falls back to traeKey', () => {
  delete process.env.TEST_TRAECN_KEY2;
  process.env.TEST_TRAE_KEY2 = 'trae_value';
  assert.strictEqual(getEnvWithFallback('TEST_TRAECN_KEY2', 'TEST_TRAE_KEY2', 'default'), 'trae_value');
  delete process.env.TEST_TRAE_KEY2;
});

test('getEnvWithFallback falls back to default', () => {
  delete process.env.TEST_TRAECN_KEY3;
  delete process.env.TEST_TRAE_KEY3;
  assert.strictEqual(getEnvWithFallback('TEST_TRAECN_KEY3', 'TEST_TRAE_KEY3', 'default'), 'default');
});

test('parseSelectors returns defaults when envValue is empty', () => {
  assert.deepStrictEqual(parseSelectors('', ['.a', '.b']), ['.a', '.b']);
});

test('parseSelectors returns defaults when envValue is null', () => {
  assert.deepStrictEqual(parseSelectors(null, ['.a', '.b']), ['.a', '.b']);
});

test('parseSelectors parses comma-separated selectors', () => {
  assert.deepStrictEqual(parseSelectors('.x, .y, .z', ['.a']), ['.x', '.y', '.z']);
});

test('parseSelectors trims whitespace', () => {
  assert.deepStrictEqual(parseSelectors(' .x , .y ', ['.a']), ['.x', '.y']);
});

test('parseSelectors filters empty entries', () => {
  assert.deepStrictEqual(parseSelectors('.x,, .y,', ['.a']), ['.x', '.y']);
});

test('parsePositiveInt returns parsed positive integers', () => {
  assert.strictEqual(parsePositiveInt('42', 10), 42);
});

test('parsePositiveInt falls back for invalid values', () => {
  assert.strictEqual(parsePositiveInt('abc', 10), 10);
  assert.strictEqual(parsePositiveInt('0', 10), 10);
  assert.strictEqual(parsePositiveInt('-5', 10), 10);
});

test('safeJsValue serializes objects and arrays as JavaScript literals', () => {
  assert.strictEqual(safeJsValue({ index: 0, title: 'Wait' }), '{"index":0,"title":"Wait"}');
  assert.strictEqual(safeJsValue(['a', 1]), '["a",1]');
});

test('safeJsValue strips control characters from strings', () => {
  assert.strictEqual(safeJsValue('bad\nvalue'), '"badvalue"');
});

test('isQueueProbeCommandText blocks bare queue probes and status-title variants', () => {
  assert.strictEqual(isQueueProbeCommandText('wait for Trae queue'), true);
  assert.strictEqual(isQueueProbeCommandText('Wait for Trae Queue 进行中 17:34'), true);
  assert.strictEqual(isQueueProbeCommandText('现在已经排到了'), true);
  assert.strictEqual(isQueueProbeCommandText('implement a queue-status panel without sending prompts'), false);
});

test('isGenericQueueProbeTask detects layered payload queue probes', () => {
  const layered = [
    '## Role and Objective',
    'You are TraeCN.',
    '## User Command Payload',
    'Wait for Trae Queue 进行中 17:34',
    'Raw params: {"task":"Wait for Trae Queue 进行中 17:34"}'
  ].join('\n');
  assert.strictEqual(isGenericQueueProbeTask(layered), true);
  assert.strictEqual(isGenericQueueProbeTask('Please implement local queue polling for the app'), false);
});

test('isForeignQueueProbeText recognizes contaminated Solo titles with menu text', () => {
  assert.strictEqual(isForeignQueueProbeText('Wait for Trae Queue 重命名 导出 复制会话 删除任务 进行中 17:34'), true);
  assert.strictEqual(isForeignQueueProbeText('Feature work 任务完成'), false);
});

(async () => {
  await asyncTest('sleep resolves after approximate delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`);
  });

  await asyncTest('safeClose calls close when available', async () => {
    let closed = false;
    await safeClose({ close: async () => { closed = true; } });
    assert.strictEqual(closed, true);
  });

  await asyncTest('safeClose ignores close errors and missing close', async () => {
    await safeClose(null);
    await safeClose({});
    await safeClose({ close: async () => { throw new Error('boom'); } });
  });

  console.log(`\n[utils.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

// ── sanitizeLog (added by systematic-optimization Round 1) ──────────────
test('sanitizeLog redacts top-level sensitive keys', () => {
  const input = { user: 'jack', password: 'secret123', apikey: 'abc', token: 't0k' };
  const out = sanitizeLog(input);
  assert.strictEqual(out.user, 'jack');
  assert.strictEqual(out.password, '[REDACTED]');
  assert.strictEqual(out.apikey, '[REDACTED]');
  assert.strictEqual(out.token, '[REDACTED]');
});

test('sanitizeLog recursively redacts nested objects and arrays', () => {
  const input = { req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' }, body: 'ok' } };
  const out = sanitizeLog(input);
  assert.strictEqual(out.req.headers.authorization, '[REDACTED]');
  assert.strictEqual(out.req.headers.cookie, '[REDACTED]');
  assert.strictEqual(out.req.body, 'ok');
});

test('sanitizeLog leaves non-sensitive keys alone and primitives as-is', () => {
  assert.strictEqual(sanitizeLog(null), null);
  assert.strictEqual(sanitizeLog('plain string'), 'plain string');
  const out = sanitizeLog({ a: 1, b: 'two', c: true });
  assert.deepStrictEqual(out, { a: 1, b: 'two', c: true });
});

test('sanitizeLog is case-insensitive on key match', () => {
  const out = sanitizeLog({ Authorization: 'a', PASSWORD: 'b', apiKey: 'c' });
  assert.strictEqual(out.Authorization, '[REDACTED]');
  assert.strictEqual(out.PASSWORD, '[REDACTED]');
  assert.strictEqual(out.apiKey, '[REDACTED]');
});

test('SENSITIVE_LOG_KEYS is frozen and longest-first', () => {
  assert.strictEqual(Object.isFrozen(SENSITIVE_LOG_KEYS), true);
  assert.strictEqual(SENSITIVE_LOG_KEYS[0], 'authorization');
  assert.strictEqual(SENSITIVE_LOG_KEYS[1], 'set-cookie');
});

// ── getGatewayContext (added by systematic-optimization Round 1) ────────
test('getGatewayContext reads TRAECN_* env vars with TRAE_* fallback', () => {
  const ctx = getGatewayContext({
    TRAECN_GATEWAY_HOST: '1.2.3.4',
    TRAECN_GATEWAY_PORT: '9000',
    TRAECN_GATEWAY_TOKEN: 'abc',
    TRAECN_GATEWAY_TIMEOUT_MS: '45000'
  });
  assert.deepStrictEqual(ctx, { host: '1.2.3.4', port: 9000, token: 'abc', timeout: 45000 });
});

test('getGatewayContext falls back to TRAE_* when TRAECN_* missing', () => {
  const ctx = getGatewayContext({
    TRAE_GATEWAY_HOST: '5.6.7.8',
    TRAE_GATEWAY_PORT: '7000',
    TRAE_GATEWAY_TOKEN: 'xyz'
  });
  assert.strictEqual(ctx.host, '5.6.7.8');
  assert.strictEqual(ctx.port, 7000);
  assert.strictEqual(ctx.token, 'xyz');
});

test('getGatewayContext uses safe defaults (127.0.0.1:8787, 30s timeout)', () => {
  const ctx = getGatewayContext({});
  assert.strictEqual(ctx.host, '127.0.0.1');
  assert.strictEqual(ctx.port, 8787);
  assert.strictEqual(ctx.token, '');
  assert.strictEqual(ctx.timeout, 30000);
});

test('getGatewayContext clamps invalid numeric values to defaults', () => {
  const ctx = getGatewayContext({ TRAECN_GATEWAY_PORT: 'not-a-number' });
  assert.strictEqual(ctx.port, 8787);
});
