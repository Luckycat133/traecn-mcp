'use strict';

/**
 * Tests for src/http/queue-state-machine.js.
 *
 * Verifies:
 *   - snapshot / queue-state transition rules (running/queued/ready)
 *   - flicker-grace semantics (recently-submitted task stays "queued")
 *   - queue-state carry-over when no fresh status arrives
 *   - hasRecentSubmittedSnapshot edge cases
 *   - normalizeModelSwitchResult sentinel vs object shapes
 *   - isIncompleteReviewText structured-report short-circuit
 *   - updateSnapshot preserves prior fields when status is clear
 *   - tryAcquire / release atomicity at the state-machine level
 */

const assert = require('assert');
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

console.log('\n[queue-state-machine.test.js] Running QueueStateMachine tests...\n');

// ── tryAcquire / release ────────────────────────────────────────────────

test('QueueStateMachine: tryAcquire + release is atomic', () => {
  const sm = new QueueStateMachine();
  assert.strictEqual(sm.tryAcquire('t1'), true);
  assert.strictEqual(sm.tryAcquire('t1'), false);
  sm.release('t1');
  assert.strictEqual(sm.tryAcquire('t1'), true);
  sm.release('t1');
});

test('QueueStateMachine: tryAcquire rejects falsy ids', () => {
  const sm = new QueueStateMachine();
  assert.strictEqual(sm.tryAcquire(null), false);
  assert.strictEqual(sm.tryAcquire(undefined), false);
  assert.strictEqual(sm.tryAcquire(''), false);
  assert.strictEqual(sm.tryAcquire(0), false);
});

// ── queue-state transitions via updateSnapshot ──────────────────────────

test('QueueStateMachine: updateSnapshot maps running -> queueState=running', () => {
  const sm = new QueueStateMachine();
  const task = { status: 'executing', submittedToTrae: true };
  sm.updateSnapshot(task, { running: true });
  assert.strictEqual(task.queueState, 'running');
  assert.ok(task.lastQueueSeenAt);
});

test('QueueStateMachine: updateSnapshot maps queued -> queueState=queued', () => {
  const sm = new QueueStateMachine();
  const task = { status: 'executing', submittedToTrae: true };
  sm.updateSnapshot(task, { queued: true, queuePosition: 3 });
  assert.strictEqual(task.queueState, 'queued');
  assert.strictEqual(task.queuePosition, 3);
});

test('QueueStateMachine: updateSnapshot maps clear -> queueState=ready', () => {
  const sm = new QueueStateMachine();
  const task = { status: 'executing', submittedToTrae: true, queueState: 'queued', queuePosition: 5 };
  sm.updateSnapshot(task, { running: false, queued: false });
  assert.strictEqual(task.queueState, 'ready');
  assert.strictEqual(task.queuePosition, null);
});

test('QueueStateMachine: updateSnapshot preserves queue during flicker grace', () => {
  const sm = new QueueStateMachine();
  const now = Date.now();
  const task = {
    status: 'executing',
    submittedToTrae: true,
    queueState: 'queued',
    queuePosition: 4,
    lastQueueSeenAt: now - 5000,
  };
  sm.updateSnapshot(task, { running: false, queued: false });
  // Still inside the grace window — queue should be preserved.
  assert.strictEqual(task.queueState, 'queued');
  assert.strictEqual(task.queuePosition, 4);
});

test('QueueStateMachine: updateSnapshot clears queue outside flicker grace', () => {
  const sm = new QueueStateMachine();
  const now = Date.now();
  const task = {
    status: 'executing',
    submittedToTrae: true,
    queueState: 'queued',
    queuePosition: 4,
    lastQueueSeenAt: now - (10 * 60 * 1000),
  };
  sm.updateSnapshot(task, { running: false, queued: false });
  assert.strictEqual(task.queueState, 'ready');
  assert.strictEqual(task.queuePosition, null);
});

// ── hasRecentSubmittedSnapshot ──────────────────────────────────────────

test('QueueStateMachine: hasRecentSubmittedSnapshot returns false for non-submitted', () => {
  const sm = new QueueStateMachine();
  const task = { status: 'executing', submittedToTrae: false, queueState: 'queued', lastQueueSeenAt: Date.now() };
  assert.strictEqual(sm.hasRecentSubmittedSnapshot(task), false);
});

test('QueueStateMachine: hasRecentSubmittedSnapshot returns true inside grace', () => {
  const sm = new QueueStateMachine();
  const task = { status: 'executing', submittedToTrae: true, queueState: 'queued', lastQueueSeenAt: Date.now() - 1000 };
  assert.strictEqual(sm.hasRecentSubmittedSnapshot(task), true);
});

// ── normalizeModelSwitchResult ──────────────────────────────────────────

test('QueueStateMachine: normalizeModelSwitchResult returns object as-is', () => {
  const sm = new QueueStateMachine();
  const out = sm.normalizeModelSwitchResult({ success: true, model: 'gpt-4' });
  assert.deepStrictEqual(out, { success: true, model: 'gpt-4' });
});

test('QueueStateMachine: normalizeModelSwitchResult parses blocked sentinel', () => {
  const sm = new QueueStateMachine();
  const out = sm.normalizeModelSwitchResult('model_switch_blocked:rate-limited');
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.switchResult, 'model_switch_blocked:rate-limited');
});

test('QueueStateMachine: normalizeModelSwitchResult accepts non-blocked sentinel', () => {
  const sm = new QueueStateMachine();
  const out = sm.normalizeModelSwitchResult('switched');
  assert.strictEqual(out.success, true);
});

// ── isIncompleteReviewText ──────────────────────────────────────────────

test('QueueStateMachine: isIncompleteReviewText returns true for empty', () => {
  const sm = new QueueStateMachine();
  assert.strictEqual(sm.isIncompleteReviewText(''), true);
  assert.strictEqual(sm.isIncompleteReviewText(null), true);
});

test('QueueStateMachine: isIncompleteReviewText accepts structured report', () => {
  const sm = new QueueStateMachine();
  const text = 'TRAECNclaw Code Review — Findings First\n1. Findings (ordered by severity) — final verdict follows here.';
  assert.strictEqual(sm.isIncompleteReviewText(text), false);
});

test('QueueStateMachine: isIncompleteReviewText rejects "let me check"', () => {
  const sm = new QueueStateMachine();
  assert.strictEqual(sm.isIncompleteReviewText('Let me check the implementation now'), true);
});

test('QueueStateMachine: percentage progress is incomplete even with completion wording', () => {
  const sm = new QueueStateMachine();
  const text = `${'正在检查仓库中的实现与测试覆盖。'.repeat(12)} 任务完成 16%`;
  assert.strictEqual(sm.isIncompleteReviewText(text), true);
  assert.strictEqual(sm.isSuccessfulResult({ text, stable: true }), false);
});

const completedResult = {
  stable: true,
  text: 'Final report: the shipping calculation was corrected and all 12 tests passed. '
    + 'The original inputs and existing behavior were preserved; the result is ready for review.'
};

test('QueueStateMachine: interrupted completion text is not reviewable and retains its output', () => {
  const sm = new QueueStateMachine();
  assert.strictEqual(sm.isReviewableResult(completedResult), true);
  const partial = Object.freeze({ ...completedResult, interrupted: true });
  assert.strictEqual(sm.isReviewableResult(partial), false);
  assert.strictEqual(partial.text, completedResult.text);
});

test('QueueStateMachine: interrupted completion text is not successful and retains its output', () => {
  const sm = new QueueStateMachine();
  assert.strictEqual(sm.isSuccessfulResult(completedResult), true);
  const partial = Object.freeze({ ...completedResult, interrupted: true });
  assert.strictEqual(sm.isSuccessfulResult(partial), false);
  assert.strictEqual(partial.text, completedResult.text);
});

console.log(`\n[queue-state-machine.test.js] Results: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
