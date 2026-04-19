'use strict';

const assert = require('assert');
const { Gateway, RateLimiter, sanitizeLog } = require('./gateway');

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

console.log('\n[gateway.test.js] Running tests...\n');

test('RateLimiter allows requests within limit', () => {
  const limiter = new RateLimiter(60000, 5);
  assert.strictEqual(limiter.check('key1'), true);
  assert.strictEqual(limiter.check('key1'), true);
});

test('RateLimiter blocks requests exceeding limit', () => {
  const limiter = new RateLimiter(60000, 2);
  limiter.check('key1');
  limiter.check('key1');
  assert.strictEqual(limiter.check('key1'), false);
});

test('RateLimiter tracks different keys independently', () => {
  const limiter = new RateLimiter(60000, 1);
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

test('sanitizeLog redacts sensitive keys', () => {
  const input = { token: 'secret123', name: 'test', password: 'pass' };
  const output = sanitizeLog(input);
  assert.strictEqual(output.token, '[REDACTED]');
  assert.strictEqual(output.password, '[REDACTED]');
  assert.strictEqual(output.name, 'test');
});

test('sanitizeLog redacts nested sensitive keys', () => {
  const input = { config: { authorization: 'Bearer xyz' }, data: 'visible' };
  const output = sanitizeLog(input);
  assert.strictEqual(output.config.authorization, '[REDACTED]');
  assert.strictEqual(output.data, 'visible');
});

test('sanitizeLog handles non-objects', () => {
  assert.strictEqual(sanitizeLog('string'), 'string');
  assert.strictEqual(sanitizeLog(123), 123);
  assert.strictEqual(sanitizeLog(null), null);
});

test('Gateway default port is 8788', () => {
  delete process.env.TRAECN_PORT;
  delete process.env.TRAE_PORT;
  delete process.env.PORT;
  const gw = new Gateway();
  assert.strictEqual(gw.port, 8788);
});

test('Gateway authenticates with valid Bearer token', () => {
  const gw = new Gateway();
  gw.token = 'test-token';
  const req = { headers: { authorization: 'Bearer test-token' } };
  assert.strictEqual(gw._authenticate(req), true);
});

test('Gateway rejects invalid Bearer token', () => {
  const gw = new Gateway();
  gw.token = 'test-token';
  const req = { headers: { authorization: 'Bearer wrong-token' } };
  assert.strictEqual(gw._authenticate(req), false);
});

test('Gateway authenticates with X-TraeCN-Token header', () => {
  const gw = new Gateway();
  gw.token = 'test-token';
  const req = { headers: { 'x-traecn-token': 'test-token' } };
  assert.strictEqual(gw._authenticate(req), true);
});

test('Gateway skips auth when no token configured', () => {
  const gw = new Gateway();
  gw.token = '';
  const req = { headers: {} };
  assert.strictEqual(gw._authenticate(req), true);
});

test('Gateway allows any origin when no allowedOrigins configured', () => {
  const gw = new Gateway();
  gw.allowedOrigins = '';
  const req = { headers: { origin: 'http://evil.com' } };
  assert.strictEqual(gw._checkOrigin(req), true);
});

test('Gateway blocks disallowed origin', () => {
  const gw = new Gateway();
  gw.allowedOrigins = 'http://localhost:3000';
  const req = { headers: { origin: 'http://evil.com' } };
  assert.strictEqual(gw._checkOrigin(req), false);
});

test('Gateway allows configured origin', () => {
  const gw = new Gateway();
  gw.allowedOrigins = 'http://localhost:3000';
  const req = { headers: { origin: 'http://localhost:3000' } };
  assert.strictEqual(gw._checkOrigin(req), true);
});

test('Gateway idempotency returns cached response', () => {
  const gw = new Gateway();
  const cachedData = { data: { result: 'cached' }, statusCode: 200 };
  gw.idempotencyKeys.set('key-1', cachedData);
  const req = { headers: { 'idempotency-key': 'key-1' } };
  const result = gw._checkIdempotency(req);
  assert.deepStrictEqual(result, cachedData);
});

console.log(`\n[gateway.test.js] Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
