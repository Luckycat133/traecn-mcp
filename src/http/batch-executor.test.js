'use strict';

/**
 * Tests for src/http/batch-executor.js.
 *
 * Verifies:
 *   - modelProbeIntervalMs clamps the cadence into [15000, 600000] ms.
 *   - backgroundResultRetryMode returns the right mode for each shape.
 *   - backgroundResultRetryMode uses the injected state machine for
 *     classification work (so changing the classifier changes the mode).
 *   - the obsolete createQueuedTask placeholder is not exposed.
 */

const assert = require('assert');
const { BatchExecutor } = require('./batch-executor');
const { QueueStateMachine } = require('./queue-state-machine');

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

console.log('\n[batch-executor.test.js] Running BatchExecutor tests...\n');

// ── modelProbeIntervalMs clamping ───────────────────────────────────────

test('BatchExecutor: modelProbeIntervalMs clamps below minimum to 15000', () => {
  const be = new BatchExecutor();
  assert.strictEqual(be.modelProbeIntervalMs(1000), 15000);
  assert.strictEqual(be.modelProbeIntervalMs(500), 15000);
});

test('BatchExecutor: modelProbeIntervalMs clamps above maximum to 600000', () => {
  const be = new BatchExecutor();
  assert.strictEqual(be.modelProbeIntervalMs(60 * 60 * 1000), 600000); // 1 hour
});

test('BatchExecutor: modelProbeIntervalMs passes through values inside range', () => {
  const be = new BatchExecutor();
  assert.strictEqual(be.modelProbeIntervalMs(30000), 30000);
  assert.strictEqual(be.modelProbeIntervalMs(120000), 120000);
});

test('BatchExecutor: modelProbeIntervalMs returns default for non-finite', () => {
  const be = new BatchExecutor();
  assert.strictEqual(be.modelProbeIntervalMs(undefined), 60000);
  assert.strictEqual(be.modelProbeIntervalMs(NaN), 60000);
  assert.strictEqual(be.modelProbeIntervalMs('not a number'), 60000);
});

// ── backgroundResultRetryMode ───────────────────────────────────────────

test('BatchExecutor: backgroundResultRetryMode returns null for clean success', () => {
  const be = new BatchExecutor({ stateMachine: new QueueStateMachine() });
  const mode = be.backgroundResultRetryMode({ stable: true, text: 'Task completed successfully. All good.' });
  assert.strictEqual(mode, null);
});

test('BatchExecutor: backgroundResultRetryMode returns resubmit for modelError', () => {
  const be = new BatchExecutor({ stateMachine: new QueueStateMachine() });
  assert.strictEqual(be.backgroundResultRetryMode({ modelError: true, text: 'x' }), 'resubmit');
});

test('BatchExecutor: backgroundResultRetryMode returns resubmit for failed text', () => {
  const be = new BatchExecutor({ stateMachine: new QueueStateMachine() });
  assert.strictEqual(be.backgroundResultRetryMode({ stable: true, text: '模型请求失败' }), 'resubmit');
});

test('BatchExecutor: backgroundResultRetryMode returns collect for timed-out', () => {
  const be = new BatchExecutor({ stateMachine: new QueueStateMachine() });
  assert.strictEqual(be.backgroundResultRetryMode({ timedOut: true, stable: false, text: 'thinking' }), 'collect');
});

const completionReport = 'Final report: the shipping calculation was corrected and all 12 tests passed. '
  + 'The original inputs and existing behavior were preserved; the result is ready for review.';
const interruptedCases = [
  { name: 'partial output', result: { stable: false, text: 'The shipping calculation is partially implemented.' } },
  { name: 'timed-out completion text', result: { stable: false, timedOut: true, text: completionReport } },
  { name: 'review-required completion text', result: { stable: true, text: completionReport }, task: { reviewRequired: true } },
  { name: 'model error with partial output', result: { modelError: true, text: 'The shipping calculation is partially implemented.' } }
];

for (const { name, result, task } of interruptedCases) {
  test(`BatchExecutor: interrupted ${name} stays unsuccessful without retrying or discarding output`, () => {
    const be = new BatchExecutor({ stateMachine: new QueueStateMachine() });
    const partial = Object.freeze({ ...result, interrupted: true });
    const retained = { ...partial };
    assert.strictEqual(be._isSuccessfulTaskResult(partial, task), false);
    assert.strictEqual(be._isReviewableTaskResult(partial, task), false);
    assert.strictEqual(be.backgroundResultRetryMode(partial, task), null);
    assert.deepStrictEqual(partial, retained);
  });
}

// ── dependency wiring ───────────────────────────────────────────────────

test('BatchExecutor: respects injected stateMachine for classification', () => {
  // A state machine that treats every text as "failed" — so any non-empty
  // result should classify as resubmit via the BatchExecutor.
  const stub = {
    isReviewableResult: () => false,
    isSuccessfulResult: () => false,
    _isFailedResultText: () => true,
    _hasMeaningfulResultText: () => true,
  };
  const be = new BatchExecutor({ stateMachine: stub });
  // modelError is false here, but _isFailedResultText returns true -> resubmit
  assert.strictEqual(be.backgroundResultRetryMode({ stable: true, text: 'anything' }), 'resubmit');
});

// ── public surface ──────────────────────────────────────────────────────

test('BatchExecutor: obsolete createQueuedTask placeholder is absent', () => {
  const be = new BatchExecutor();
  assert.strictEqual(typeof be.createQueuedTask, 'undefined');
});

console.log(`\n[batch-executor.test.js] Results: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
