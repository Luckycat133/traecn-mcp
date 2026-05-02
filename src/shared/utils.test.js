'use strict';

const assert = require('assert');
const { getEnvWithFallback, parseSelectors, parsePositiveInt, sleep, escapeJsString } = require('../shared/utils');

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

  console.log(`\n[utils.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
