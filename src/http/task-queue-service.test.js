'use strict';

/**
 * Tests for src/http/task-queue-service.js.
 *
 * Verifies:
 *   - persistence path resolution honours env / OS defaults
 *   - repeated persist calls retain the same active-task snapshot
 *   - syncHistoryMirror no-ops when the store lacks ensureTask
 *   - restore() is a no-op while mock bridge is enabled
 *   - tryAcquire / release provide atomic per-task claim
 *   - result-classification helpers (isReviewableResult, isSuccessfulResult,
 *     looksLikeQueueNotice, isQueuedTaskResult, isIncompleteReviewText,
 *     defaultQuestionDialogAnswer) behave correctly
 *   - backgroundResultRetryMode returns the right mode for each shape
 *   - updateSnapshot / applyRecentSnapshot mirror flicker-grace semantics
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskQueueService } = require('./task-queue-service');
const { createRunner } = require('../shared/test-runner');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tqs-test-'));
const PERSIST_PATH = path.join(TMP_DIR, 'active-queue.json');

const runner = createRunner('task-queue-service.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[task-queue-service.test.js] Running TaskQueueService tests...\n');

test('TaskQueueService: persistence path honours env override', () => {
  process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH = PERSIST_PATH;
  const svc = new TaskQueueService();
  assert.strictEqual(svc.persistencePath, path.resolve(PERSIST_PATH));
  delete process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH;
});

test('TaskQueueService: persistence path uses OS default when no override', () => {
  delete process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH;
  delete process.env.TRAE_ACTIVE_QUEUE_PERSISTENCE_PATH;
  const svc = new TaskQueueService();
  const expected = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw', 'active-queue.json')
    : path.join(os.homedir(), '.traecnclaw', 'active-queue.json');
  assert.strictEqual(svc.persistencePath, expected);
});

test('TaskQueueService: obsolete createQueuedTask placeholder is absent', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(typeof svc.createQueuedTask, 'undefined');
});

asyncTest('TaskQueueService: repeated persists preserve the active-task snapshot', async () => {
  const svc = new TaskQueueService({
    persistencePath: PERSIST_PATH,
    isTerminalStatus: status => ['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected'].includes(status)
  });
  const taskQueue = new Map();
  taskQueue.set('task-1', { taskId: 'task-1', status: 'queued', task: 'a' });
  taskQueue.set('task-2', { taskId: 'task-2', status: 'executing', task: 'b' });
  taskQueue.set('task-3', { taskId: 'task-3', status: 'done', task: 'c' });

  // Repeated caller promises must all observe the completed durable write.
  await Promise.all([svc.persist(taskQueue), svc.persist(taskQueue), svc.persist(taskQueue)]);

  const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  // Terminal task 'done' must be excluded.
  assert.strictEqual(parsed.tasks.length, 2);
  const ids = parsed.tasks.map(t => t.taskId).sort();
  assert.deepStrictEqual(ids, ['task-1', 'task-2']);
});

test('TaskQueueService: restore is a no-op while mock bridge is enabled', () => {
  const svc = new TaskQueueService({
    persistencePath: PERSIST_PATH,
    isMockBridge: () => true,
  });
  const taskQueue = new Map();
  const restored = svc.restore(taskQueue);
  assert.strictEqual(restored, 0);
  assert.strictEqual(taskQueue.size, 0);
});

test('TaskQueueService: restore drops persisted generic queue-probe tasks', () => {
  const queueFile = path.join(TMP_DIR, 'queue-probe-active-queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({
    version: 1,
    tasks: [
      {
        taskId: 'probe_task',
        status: 'queued',
        task: 'wait for Trae queue',
        createdAt: Date.now()
      },
      {
        taskId: 'real_task',
        status: 'queued',
        task: 'implement the queue status panel without sending prompts',
        createdAt: Date.now()
      }
    ]
  }), 'utf8');

  const mirrored = [];
  const svc = new TaskQueueService({
    persistencePath: queueFile,
    taskHistoryStore: {
      ensureTask: (taskId) => {
        mirrored.push(taskId);
      }
    }
  });
  const taskQueue = new Map();

  const restored = svc.restore(taskQueue);

  assert.strictEqual(restored, 1);
  assert.strictEqual(taskQueue.has('probe_task'), false);
  assert.strictEqual(taskQueue.has('real_task'), true);
  assert.deepStrictEqual(mirrored, ['real_task']);
  const rewritten = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.deepStrictEqual(rewritten.tasks.map(task => task.taskId), ['real_task']);
});

test('TaskQueueService: tryAcquire is atomic per taskId', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.tryAcquire('task-x'), true);
  assert.strictEqual(svc.tryAcquire('task-x'), false);
  svc.release('task-x');
  assert.strictEqual(svc.tryAcquire('task-x'), true);
  svc.release('task-x');
});

test('TaskQueueService: tryAcquire rejects falsy task ids', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.tryAcquire(null), false);
  assert.strictEqual(svc.tryAcquire(undefined), false);
  assert.strictEqual(svc.tryAcquire(''), false);
});

test('TaskQueueService: isReviewableResult requires stable + 80+ chars', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.isReviewableResult(null), false);
  assert.strictEqual(svc.isReviewableResult({ stable: true, text: 'short' }), false);
  const long = 'a'.repeat(120);
  assert.strictEqual(svc.isReviewableResult({ stable: true, text: long }), true);
  assert.strictEqual(svc.isReviewableResult({ stable: false, text: long }), false);
});

test('TaskQueueService: isSuccessfulResult requires stable non-empty non-failed text', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const goodText = 'Task completed successfully. The implementation looks correct.';
  assert.strictEqual(svc.isSuccessfulResult({ stable: true, text: goodText }), true);
  assert.strictEqual(svc.isSuccessfulResult({ stable: true, text: '模型请求失败' }), false);
  assert.strictEqual(svc.isSuccessfulResult({ stable: false, text: goodText }), false);
});

test('TaskQueueService: looksLikeQueueNotice recognises Chinese + English queue hints', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.looksLikeQueueNotice('排队提醒'), true);
  assert.strictEqual(svc.looksLikeQueueNotice('queue position: 3'), true);
  assert.strictEqual(svc.looksLikeQueueNotice('you are still in the queue'), true);
  assert.strictEqual(svc.looksLikeQueueNotice('Task completed'), false);
});

test('TaskQueueService: isQueuedTaskResult honours queued flag and timed-out notice', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.isQueuedTaskResult({ queued: true }), true);
  assert.strictEqual(svc.isQueuedTaskResult({ timedOut: true, stable: false, text: '排队提醒' }), true);
  assert.strictEqual(svc.isQueuedTaskResult({ stable: true, text: 'Task completed' }), false);
});

test('TaskQueueService: defaultQuestionDialogAnswer picks workspace option', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const result = { options: [{ label: 'Current workspace changes' }, { label: 'Skip' }] };
  assert.strictEqual(svc.defaultQuestionDialogAnswer(result, 'auto'), 'Current workspace changes');
  // Custom action string is returned verbatim (minus the answer: prefix).
  assert.strictEqual(svc.defaultQuestionDialogAnswer(result, 'answer:hello world'), 'hello world');
});

test('TaskQueueService: backgroundResultRetryMode classifies outcomes', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.backgroundResultRetryMode(null), null);
  assert.strictEqual(svc.backgroundResultRetryMode({ modelError: true, text: 'x' }), 'resubmit');
  assert.strictEqual(svc.backgroundResultRetryMode({ stable: true, text: '模型请求失败' }), 'resubmit');
  // Transient: stable=false + timed-out means collect again.
  assert.strictEqual(svc.backgroundResultRetryMode({ timedOut: true, stable: false, text: 'thinking' }), 'collect');
  // Clean success → null.
  assert.strictEqual(svc.backgroundResultRetryMode({ stable: true, text: 'Task completed successfully.' }), null);
});

test('TaskQueueService: interrupted results retain partial output without resubmitting or collecting', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const completionReport = 'Final report: the shipping calculation was corrected and all 12 tests passed. '
    + 'The original inputs and existing behavior were preserved; the result is ready for review.';
  const cases = [
    { result: { stable: false, text: 'The shipping calculation is partially implemented.' } },
    { result: { stable: false, timedOut: true, text: completionReport } },
    { result: { stable: true, text: completionReport }, reviewRequired: true },
    { result: { modelError: true, text: 'The shipping calculation is partially implemented.' } }
  ];
  for (const { result, reviewRequired } of cases) {
    const task = { result: Object.freeze({ ...result, interrupted: true }), reviewRequired };
    const retained = { ...task.result };
    assert.strictEqual(svc.isSuccessfulResult(task.result), false);
    assert.strictEqual(svc.isReviewableResult(task.result), false);
    assert.strictEqual(svc.backgroundResultRetryMode(task.result, task), null);
    assert.deepStrictEqual(task.result, retained);
  }
  svc.close();
});

test('TaskQueueService: applyRecentSnapshot carries queued state forward', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const taskQueue = new Map();
  const now = Date.now();
  taskQueue.set('t1', {
    taskId: 't1',
    status: 'executing',
    submittedToTrae: true,
    queueState: 'queued',
    queueMessage: '排队提醒',
    lastQueueSeenAt: now,
  });
  const out = svc.applyRecentSnapshot({}, taskQueue);
  assert.strictEqual(out.queued, true);
  assert.strictEqual(out.queueSnapshotSource, 'recent_submitted_task');
});

test('TaskQueueService: applyRecentSnapshot is identity when no task matches', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const taskQueue = new Map();
  const out = svc.applyRecentSnapshot({ running: false }, taskQueue);
  assert.strictEqual(out.queueSnapshotSource, undefined);
});

test('TaskQueueService: updateSnapshot sets lastQueueSeenAt while queue active', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const task = { status: 'executing', submittedToTrae: true, queueState: 'queued' };
  svc.updateSnapshot(task, { queued: true });
  assert.ok(task.lastQueueSeenAt);
  assert.strictEqual(task.queueState, 'queued');
});

test('TaskQueueService: updateSnapshot clears queue position when queue is clear', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const task = { status: 'executing', submittedToTrae: true, queueState: 'queued', queuePosition: 5 };
  svc.updateSnapshot(task, { running: false, queued: false });
  assert.strictEqual(task.queueState, 'ready');
  assert.strictEqual(task.queuePosition, null);
});

test('TaskQueueService: getDetailsFromStatus mirrors state mapping', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.getDetailsFromStatus({ running: true }).state, 'running');
  assert.strictEqual(svc.getDetailsFromStatus({ queued: true }).state, 'queued');
  assert.strictEqual(svc.getDetailsFromStatus({}).state, 'ready');
});

test('TaskQueueService: normalizeModelSwitchResult extracts sentinel blocks', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const blocked = svc.normalizeModelSwitchResult('model_switch_blocked:rate-limited');
  assert.strictEqual(blocked.success, false);
  const ok = svc.normalizeModelSwitchResult({ success: true, model: 'gpt-4' });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.model, 'gpt-4');
});

test('TaskQueueService: background polling start/stop toggles state', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  assert.strictEqual(svc.hasBackgroundPolling(), false);
  let probeCalls = 0;
  const timer = svc.startBackgroundPolling({
    runProbe: () => { probeCalls++; },
    intervalMs: 1000000,
    setIntervalImpl: (cb, ms) => ({ cb, ms }),
    clearIntervalImpl: () => {},
  });
  assert.strictEqual(svc.hasBackgroundPolling(), true);
  assert.strictEqual(timer.ms, 1000000);
  timer.cb();
  assert.strictEqual(probeCalls, 1);
  svc.stopBackgroundPolling({ clearIntervalImpl: cleared => assert.strictEqual(cleared, timer) });
  assert.strictEqual(svc.hasBackgroundPolling(), false);
});

test('TaskQueueService: resumeApprovalRequiredTasksAfterDialogAnswer finds blocked tasks', () => {
  const svc = new TaskQueueService({ persistencePath: PERSIST_PATH });
  const taskQueue = new Map([
    ['t1', { status: 'approval_required' }],
    ['t2', { status: 'queued' }],
    ['t3', { status: 'approval_required' }],
  ]);
  const resumed = svc.resumeApprovalRequiredTasksAfterDialogAnswer({}, taskQueue);
  assert.deepStrictEqual(resumed.sort(), ['t1', 't3']);
});

(async () => {
  await pendingAsyncTests();
  summary();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  if (runner.failed > 0) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
