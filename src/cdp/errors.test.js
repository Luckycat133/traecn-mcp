'use strict';

const assert = require('assert');
const { TraeCNAutomationError, TraeAutomationError } = require('../cdp/errors');
const { createRunner } = require('../shared/test-runner');
const runner = createRunner('errors.test.js');
const { test, summary } = runner;

console.log('\n[errors.test.js] Running tests...\n');

test('TraeCNAutomationError is instance of Error', () => {
  const err = new TraeCNAutomationError('test', 'TEST_CODE');
  assert.ok(err instanceof Error);
  assert.strictEqual(err.message, 'test');
  assert.strictEqual(err.code, 'TEST_CODE');
});

test('TraeAutomationError is alias for TraeCNAutomationError', () => {
  assert.strictEqual(TraeAutomationError, TraeCNAutomationError);
});

test('TraeCNAutomationError.selectorNotFound creates correct error', () => {
  const err = TraeCNAutomationError.selectorNotFound('composer', ['.a', '.b']);
  assert.ok(err instanceof TraeCNAutomationError);
  assert.strictEqual(err.code, 'SELECTOR_NOT_FOUND');
  assert.ok(err.message.includes('composer'));
  assert.ok(err.details.selectors.includes('.a'));
});

test('TraeCNAutomationError.responseTimeout creates correct error', () => {
  const err = TraeCNAutomationError.responseTimeout(30000);
  assert.ok(err instanceof TraeCNAutomationError);
  assert.strictEqual(err.code, 'RESPONSE_TIMEOUT');
  assert.ok(err.message.includes('30000'));
  assert.strictEqual(err.details.timeoutMs, 30000);
});

test('TraeCNAutomationError.connectionFailed creates correct error', () => {
  const err = TraeCNAutomationError.connectionFailed('host', 9222, 'ECONNREFUSED');
  assert.ok(err instanceof TraeCNAutomationError);
  assert.strictEqual(err.code, 'CONNECTION_FAILED');
  assert.ok(err.message.includes('host'));
  assert.ok(err.message.includes('9222'));
});

test('TraeCNAutomationError.targetNotFound creates correct error', () => {
  const err = TraeCNAutomationError.targetNotFound({ title: 'test' });
  assert.strictEqual(err.code, 'TARGET_NOT_FOUND');
  assert.ok(err.message.includes('test'));
});

test('TraeCNAutomationError.sessionPrepareFailed creates correct error', () => {
  const err = TraeCNAutomationError.sessionPrepareFailed('timeout');
  assert.strictEqual(err.code, 'SESSION_PREPARE_FAILED');
  assert.ok(err.message.includes('timeout'));
});

test('TraeCNAutomationError.sendFailed creates correct error', () => {
  const err = TraeCNAutomationError.sendFailed('disconnected');
  assert.strictEqual(err.code, 'SEND_FAILED');
  assert.ok(err.message.includes('disconnected'));
  assert.deepStrictEqual(err.details, { cause: 'disconnected' });
});

test('sendFailed preserves explicit post-dispatch context without changing the error contract', () => {
  const context = { submissionDispatched: true, cause: 'ignored caller override' };
  const err = TraeCNAutomationError.sendFailed('confirmation timed out', context);
  assert.strictEqual(err.code, 'SEND_FAILED');
  assert.strictEqual(err.details.submissionDispatched, true);
  assert.strictEqual(err.details.cause, 'confirmation timed out');
  assert.strictEqual(context.cause, 'ignored caller override');
});

test('TraeCNAutomationError has proper stack trace', () => {
  const err = new TraeCNAutomationError('test', 'CODE');
  assert.ok(typeof err.stack === 'string');
  assert.ok(err.stack.includes('TraeCNAutomationError'));
});

test('TraeCNAutomationError details default to empty object', () => {
  const err = new TraeCNAutomationError('test', 'CODE');
  assert.deepStrictEqual(err.details, {});
});

test('TraeCNAutomationError name is set correctly', () => {
  const err = new TraeCNAutomationError('test', 'CODE');
  assert.strictEqual(err.name, 'TraeCNAutomationError');
});

// ── Newly classified factories (stage-2) ────────────────────────────────

test('TraeCNAutomationError.invalidInput carries field/value/reason', () => {
  const err = TraeCNAutomationError.invalidInput('label', '', 'must be non-empty');
  assert.strictEqual(err.code, 'INVALID_INPUT');
  assert.deepStrictEqual(err.details, { field: 'label', value: '', reason: 'must be non-empty' });
});

test('TraeCNAutomationError.reviewGateBlocked wraps reason', () => {
  const err = TraeCNAutomationError.reviewGateBlocked('awaiting human');
  assert.strictEqual(err.code, 'REVIEW_GATE_BLOCKED');
  assert.strictEqual(err.message, 'Review gate blocked action: awaiting human');
});

test('TraeCNAutomationError.composerFocusFailed records cause', () => {
  const err = TraeCNAutomationError.composerFocusFailed('no editable');
  assert.strictEqual(err.code, 'COMPOSER_FOCUS_FAILED');
  assert.strictEqual(err.details.cause, 'no editable');
});

test('TraeCNAutomationError.cdpTimeout includes timeoutMs', () => {
  const err = TraeCNAutomationError.cdpTimeout('Runtime.evaluate', 30000);
  assert.strictEqual(err.code, 'CDP_TIMEOUT');
  assert.strictEqual(err.details.timeoutMs, 30000);
});

test('TraeCNAutomationError.cdpDisconnected preserves reason', () => {
  const err = TraeCNAutomationError.cdpDisconnected('socket hangup');
  assert.strictEqual(err.code, 'CDP_DISCONNECTED');
  assert.strictEqual(err.message, 'CDP connection lost: socket hangup');
});

test('TraeCNAutomationError.webhookFailed truncates long bodies', () => {
  const long = 'x'.repeat(4096);
  const err = TraeCNAutomationError.webhookFailed('http://localhost/cb', 500, long);
  assert.strictEqual(err.code, 'WEBHOOK_FAILED');
  assert.strictEqual(err.details.statusCode, 500);
  assert.ok(err.details.body.length <= 1024, 'body should be truncated to <= 1024 chars');
});

summary();
if (runner.failed > 0) process.exit(1);
