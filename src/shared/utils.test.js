'use strict';

const assert = require('assert');
const { getEnvWithFallback, parseSelectors, parsePositiveInt, sleep, escapeJsString, safeClose, sanitizeLog, getGatewayContext } = require('../shared/utils');

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

test('escapeJsString escapes backslashes', () => {
  assert.strictEqual(escapeJsString('a\\b'), 'a\\\\b');
});

test('escapeJsString escapes single quotes', () => {
  assert.strictEqual(escapeJsString("it's"), "it\\'s");
});

test('escapeJsString escapes double quotes', () => {
  assert.strictEqual(escapeJsString('say "hello"'), 'say \\"hello\\"');
});

test('escapeJsString escapes newlines', () => {
  assert.strictEqual(escapeJsString('line1\nline2'), 'line1\\nline2');
});

test('escapeJsString handles empty string', () => {
  assert.strictEqual(escapeJsString(''), '');
});

test('escapeJsString handles string with no special chars', () => {
  assert.strictEqual(escapeJsString('hello world'), 'hello world');
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

  test('sanitizeLog redacts known sensitive keys at top level', () => {
    assert.deepStrictEqual(
      sanitizeLog({ token: 'abc', password: 'p', name: 'ok' }),
      { token: '[REDACTED]', password: '[REDACTED]', name: 'ok' }
    );
  });

  test('sanitizeLog walks nested objects and arrays', () => {
    const out = sanitizeLog({ a: { authorization: 'Bearer x', b: { api_key: 'k' } }, list: [{ token: 't' }, 'safe'] });
    assert.strictEqual(out.a.authorization, '[REDACTED]');
    assert.strictEqual(out.a.b.api_key, '[REDACTED]');
    assert.strictEqual(out.list[0].token, '[REDACTED]');
    assert.strictEqual(out.list[1], 'safe');
  });

  test('sanitizeLog leaves primitives alone', () => {
    assert.strictEqual(sanitizeLog(null), null);
    assert.strictEqual(sanitizeLog('hello'), 'hello');
    assert.strictEqual(sanitizeLog(42), 42);
  });

  test('getGatewayContext reads TRAECN_* with TRAE_* fallback and defaults', () => {
    const empty = getGatewayContext({});
    assert.strictEqual(empty.host, '127.0.0.1');
    assert.strictEqual(empty.port, 8787);
    assert.strictEqual(empty.token, '');
    assert.strictEqual(empty.timeout, 30000);

    const full = getGatewayContext({
      TRAECN_GATEWAY_HOST: 'remote.local',
      TRAE_GATEWAY_PORT: '9999',
      TRAECN_GATEWAY_TOKEN: 'tok',
      TRAECN_GATEWAY_TIMEOUT_MS: '5000',
    });
    assert.strictEqual(full.host, 'remote.local');
    assert.strictEqual(full.port, 9999);
    assert.strictEqual(full.token, 'tok');
    assert.strictEqual(full.timeout, 5000);
  });

  test('getGatewayContext tolerates non-numeric port and timeout', () => {
    const ctx = getGatewayContext({ TRAECN_GATEWAY_PORT: 'oops', TRAECN_GATEWAY_TIMEOUT_MS: 'NaN' });
    assert.strictEqual(ctx.port, 8787);
    assert.strictEqual(ctx.timeout, 30000);
  });

  console.log(`\n[utils.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
