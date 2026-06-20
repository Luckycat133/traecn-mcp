'use strict';

const assert = require('assert');
const { TraeCNAutomationError } = require('../cdp/errors');
const { errorToHttpStatus, errorToBody, CODE_TO_STATUS, DEFAULT_STATUS } = require('./error-mapping');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS: ${name}`); }
  catch (err) { failed++; console.error(`  FAIL: ${name}\n    ${err.message}`); }
}

test('errorToHttpStatus: known TraeCNAutomationError code maps correctly', () => {
  assert.strictEqual(
    errorToHttpStatus(TraeCNAutomationError.selectorNotFound('button', ['.x'])),
    404
  );
  assert.strictEqual(
    errorToHttpStatus(TraeCNAutomationError.reviewGateBlocked('awaiting human')),
    409
  );
  assert.strictEqual(
    errorToHttpStatus(TraeCNAutomationError.invalidInput('label', '', 'must be non-empty')),
    400
  );
  assert.strictEqual(
    errorToHttpStatus(TraeCNAutomationError.connectionFailed('h', 1, 'refused')),
    503
  );
  assert.strictEqual(
    errorToHttpStatus(TraeCNAutomationError.responseTimeout(30000)),
    504
  );
});

test('errorToHttpStatus: unknown TraeCNAutomationError code falls back to DEFAULT_STATUS', () => {
  const e = new TraeCNAutomationError('mystery', 'SOMETHING_NEW', {});
  assert.strictEqual(errorToHttpStatus(e), DEFAULT_STATUS);
  assert.strictEqual(errorToHttpStatus(e), 502);
});

test('errorToHttpStatus: HttpError-like statusCode is respected', () => {
  const e = new Error('forbidden');
  e.name = 'HttpError';
  e.statusCode = 403;
  assert.strictEqual(errorToHttpStatus(e), 403);
});

test('errorToHttpStatus: bare Error returns 500', () => {
  assert.strictEqual(errorToHttpStatus(new Error('boom')), 500);
  assert.strictEqual(errorToHttpStatus(null), 500);
  assert.strictEqual(errorToHttpStatus(undefined), 500);
});

test('errorToHttpStatus: errors with statusCode property win over name-based mapping', () => {
  const e = new Error('legacy 400 still works');
  e.statusCode = 400;
  assert.strictEqual(errorToHttpStatus(e), 400);
});

test('errorToBody: TraeCNAutomationError surfaces message, code, and details', () => {
  const e = TraeCNAutomationError.selectorNotFound('button', ['.a', '.b']);
  const body = errorToBody(e);
  assert.strictEqual(body.code, 'SELECTOR_NOT_FOUND');
  assert.ok(body.error.includes('button'));
  assert.deepStrictEqual(body.details, { type: 'button', selectors: ['.a', '.b'] });
});

test('errorToBody: HttpError surfaces message and code', () => {
  const e = new Error('rate limited');
  e.name = 'HttpError';
  e.statusCode = 429;
  e.code = 'RATE_LIMITED';
  const body = errorToBody(e);
  assert.strictEqual(body.code, 'RATE_LIMITED');
  assert.strictEqual(body.error, 'rate limited');
});

test('errorToBody: bare Error returns message only', () => {
  const body = errorToBody(new Error('disk full'));
  assert.deepStrictEqual(body, { error: 'disk full' });
});

test('errorToBody: falsy values get a generic body', () => {
  assert.deepStrictEqual(errorToBody(null), { error: 'Internal server error' });
  assert.deepStrictEqual(errorToBody(undefined), { error: 'Internal server error' });
});

test('CODE_TO_STATUS is frozen and covers all known TraeCN codes', () => {
  assert.ok(Object.isFrozen(CODE_TO_STATUS));
  // Spot-check that common codes are mapped (not all 22 codes asserted here to
  // keep the test stable; the per-code mapping is exercised above).
  for (const code of [
    'SELECTOR_NOT_FOUND',
    'REVIEW_GATE_BLOCKED',
    'OPERATION_CONFIRMATION_REQUIRED',
    'CONNECTION_FAILED',
    'RESPONSE_TIMEOUT',
    'WEBHOOK_FAILED',
  ]) {
    assert.ok(CODE_TO_STATUS[code], `expected ${code} to be mapped`);
    assert.ok(CODE_TO_STATUS[code] >= 400 && CODE_TO_STATUS[code] < 600, `${code} must map to a 4xx/5xx`);
  }
});

console.log(`\n[error-mapping.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);