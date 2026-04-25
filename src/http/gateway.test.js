'use strict';

const assert = require('assert');
const { RateLimiter, sanitizeLog } = require('./gateway');

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

console.log(`\n[gateway.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
