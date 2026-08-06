'use strict';

/**
 * Deterministic fault-injection / regression tests for task restart, retry,
 * and reconnection boundaries.
 *
 * These tests compose the real TaskOrchestrator, TaskQueueService, TaskStore,
 * and TaskEventStore with temp directories and deterministic clocks so the
 * restart/retry cursor invariants listed in the maintainer Skill roadmap can
 * be exercised without a live TraeCN desktop:
 *
 *   - restart before submit, after durable accept, after Trae submission,
 *     during result collection, and after a terminal event;
 *   - idempotency replay returns the original task identity after restart;
 *   - TaskEventStore subscription cursors survive restart and do not replay
 *     another task's events;
 *   - TaskStore write failure rolls back candidate acceptance and does not
 *     store an idempotency replay.
 *
 * The boundaries protected here: task identity, idempotency, pagination,
 * trimming, replay, and persistence semantics.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskQueueService } = require('./task-queue-service');
const { TaskOrchestrator } = require('./task-orchestrator');
const { TaskEventStore } = require('../shared/task-event-store');
const { TaskHistoryStore } = require('../shared/task-history');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('task-restart-retry.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

const TERMINAL_STATUSES = ['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected'];
const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-restart-retry-'));
}

function newHistoryStore(persistencePath) {
  return new TaskHistoryStore({
    persistencePath,
    taskIdGenerator: () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  });
}

function newQueueService(persistencePath, { taskHistoryStore, onWritePhase } = {}) {
  return new TaskQueueService({
    logger: { error() {}, warn() {}, log() {} },
    persistencePath,
    taskHistoryStore,
    isTerminalStatus,
    onWritePhase
  });
}

function newOrchestrator({ taskHistoryStore, taskQueueService, taskQueue, now = () => 1000000 }) {
  return new TaskOrchestrator({
    taskHistoryStore,
    taskQueue,
    taskQueueService,
    getDriverConfig: () => ({ queuePerTaskTimeoutMs: 600000, queueMaxWaitMs: null }),
    normalizeFollowupTasks: (items) => (Array.isArray(items) ? items.map(item => ({
      task: typeof item === 'string' ? item : item.task,
      reviewRequired: item.reviewRequired !== false
    })) : []),
    normalizeCompletionChecks: () => ({ requiredFiles: [], requiredText: [] }),
    hasCompletionChecks: () => false,
    normalizeFallbackModels: () => [],
    modelProbeIntervalMs: () => 60000,
    normalizeAutoApproveDialog: (value) => value || null,
    normalizeSoloChatTarget: (value) => value || null,
    syncTaskHistoryMirror: () => {},
    now
  });
}

function buildAcceptedTask(orchestrator, overrides = {}) {
  return orchestrator.createQueuedTask({
    task: 'restart-retry boundary task',
    sessionId: 'session-restart',
    idempotencyKey: `key-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides
  }, { queued: false, running: false, canSubmit: true });
}

test('restart before Trae submission restores the task as queued, not executing', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    let service = newQueueService(queuePath, { taskHistoryStore: history });
    let orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = buildAcceptedTask(orchestrator, { idempotencyKey: 'pre-submit-key' });
    assert.strictEqual(task.status, 'queued');
    assert.strictEqual(task.submittedToTrae, false);
    service.close();

    // Restart: new service + orchestrator pointing at the same durable file.
    service = newQueueService(queuePath, { taskHistoryStore: history });
    orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const restored = service.restore(queue);
    assert.strictEqual(restored, 1);
    const restoredTask = queue.get(task.taskId);
    assert.ok(restoredTask, 'task must be restored into the queue');
    assert.strictEqual(restoredTask.status, 'queued', 'pre-submit task must not become executing');
    assert.strictEqual(restoredTask.submittedToTrae, false);
    service.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart after durable accept preserves task identity, idempotency key, and history', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = buildAcceptedTask(orchestrator, { idempotencyKey: 'durable-accept-key' });
    const originalTaskId = task.taskId;
    const originalCreatedAt = task.createdAt;
    service.close();

    const restoredHistory = newHistoryStore(historyPath);
    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, { taskHistoryStore: restoredHistory });
    const restored = restoredService.restore(restoredQueue);
    assert.strictEqual(restored, 1);
    const restoredTask = restoredQueue.get(originalTaskId);
    assert.ok(restoredTask);
    assert.strictEqual(restoredTask.taskId, originalTaskId);
    assert.strictEqual(restoredTask.idempotencyKey, 'durable-accept-key');
    assert.strictEqual(restoredTask.createdAt, originalCreatedAt);
    // History mirror must still reference the same task identity.
    const historyTask = restoredHistory.getTask(originalTaskId);
    assert.ok(historyTask, 'history must retain the accepted task');
    restoredService.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart after Trae submission preserves submittedToTrae and executing status', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = buildAcceptedTask(orchestrator, { idempotencyKey: 'submitted-key' });
    // Simulate the gateway submitting the task to Trae.
    task.status = 'executing';
    task.submittedToTrae = true;
    task.submittedAt = 1100000;
    assert.strictEqual(service.persist(queue), true);
    service.close();

    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, { taskHistoryStore: history });
    restoredService.restore(restoredQueue);
    const restoredTask = restoredQueue.get(task.taskId);
    assert.ok(restoredTask);
    assert.strictEqual(restoredTask.status, 'executing', 'submitted executing task must not be demoted to queued');
    assert.strictEqual(restoredTask.submittedToTrae, true, 'submitted flag must survive restart');
    // The restore path must not clear submittedAt.
    assert.strictEqual(restoredTask.submittedAt, 1100000);
    restoredService.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart during result collection keeps the task executing with its partial result', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = buildAcceptedTask(orchestrator, { idempotencyKey: 'collecting-key' });
    task.status = 'executing';
    task.submittedToTrae = true;
    task.result = { text: 'partial answer so far', stable: false };
    assert.strictEqual(service.persist(queue), true);
    service.close();

    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, { taskHistoryStore: history });
    restoredService.restore(restoredQueue);
    const restoredTask = restoredQueue.get(task.taskId);
    assert.ok(restoredTask);
    assert.strictEqual(restoredTask.status, 'executing');
    assert.deepStrictEqual(restoredTask.result, { text: 'partial answer so far', stable: false });
    restoredService.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart after a terminal event does not restore the finished task into the active queue', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = buildAcceptedTask(orchestrator, { idempotencyKey: 'terminal-key' });
    task.status = 'done';
    task.result = { text: 'final answer', stable: true };
    task.completedAt = '2026-08-05T00:00:00.000Z';
    // Terminal tasks are filtered out by TaskStore.persist; the snapshot on
    // disk must therefore contain zero active tasks.
    assert.strictEqual(service.persist(queue), true);
    service.close();

    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, { taskHistoryStore: history });
    const restored = restoredService.restore(restoredQueue);
    assert.strictEqual(restored, 0, 'terminal task must not re-enter the active queue');
    assert.strictEqual(restoredQueue.size, 0);
    restoredService.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotency replay after restart returns the original task identity with HTTP 202', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = buildAcceptedTask(orchestrator, { idempotencyKey: 'replay-after-restart-key' });
    service.close();

    // A retry arrives after a gateway restart. The active queue has been
    // rehydrated from disk; the replay must resolve to the original task
    // identity and the accepted status code, not a duplicate submission.
    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, { taskHistoryStore: history });
    const restoredOrchestrator = newOrchestrator({
      taskHistoryStore: history,
      taskQueueService: restoredService,
      taskQueue: restoredQueue
    });
    restoredService.restore(restoredQueue);
    const replay = restoredOrchestrator.resolveIdempotentTask('replay-after-restart-key');
    assert.ok(replay, 'replay must resolve to the restored task');
    assert.strictEqual(replay.taskId, task.taskId);
    assert.strictEqual(replay.statusCode, 202);
    assert.strictEqual(replay.status, 'accepted');
    assert.strictEqual(restoredQueue.size, 1, 'replay must not create a duplicate task');
    restoredService.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotency replay reports the real terminal status once the task has finished', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = buildAcceptedTask(orchestrator, { idempotencyKey: 'terminal-replay-key' });
    task.status = 'done';
    // The terminal task is not persisted to the active queue, so the replay
    // must NOT resolve from the queue. (A real gateway still has the in-memory
    // idempotency cache for the short TTL window; this test asserts the
    // queue-ownership path does not falsely report a terminal task as
    // accepted after it has been trimmed from the active store.)
    assert.strictEqual(service.persist(queue), true);
    service.close();

    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, { taskHistoryStore: history });
    const restoredOrchestrator = newOrchestrator({
      taskHistoryStore: history,
      taskQueueService: restoredService,
      taskQueue: restoredQueue
    });
    restoredService.restore(restoredQueue);
    const replay = restoredOrchestrator.resolveIdempotentTask('terminal-replay-key');
    assert.strictEqual(replay, null, 'terminal task trimmed from the active queue must not replay as accepted');
    restoredService.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskStore write failure rolls back acceptance, fails history, and stores no idempotency replay', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  // Poison the persistence directory so the durable write fails.
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'blocks mkdir', 'utf8');
  const poisonedPath = path.join(blocker, 'active-queue.json');
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(poisonedPath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    assert.throws(
      () => orchestrator.createQueuedTask(
        { task: 'must not be accepted', idempotencyKey: 'rolled-back-key' },
        { queued: true }
      ),
      (error) => {
        assert.strictEqual(error.code, 'TASK_STORE_UNAVAILABLE');
        return true;
      }
    );
    // The candidate must not remain in the queue.
    assert.strictEqual(queue.size, 0);
    // The replay must not resolve: nothing was durably accepted.
    assert.strictEqual(orchestrator.resolveIdempotentTask('rolled-back-key'), null);
    // History must have recorded the failure so the rolled-back task is
    // visible to operators instead of disappearing silently.
    const failedRecords = Array.from(history.tasks.values()).filter(t => t.status === 'failed');
    assert.ok(failedRecords.length >= 1, 'history must record the failed acceptance');
    service.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskEventStore survives restart and keeps subscription cursors independent per client', () => {
  const dir = makeTempDir();
  const eventsPath = path.join(dir, 'events.json');
  try {
    const firstStore = new TaskEventStore({ persistencePath: eventsPath });
    const eventA = firstStore.append({ type: 'task.updated', taskId: 'task-a', status: 'executing' });
    const eventB = firstStore.append({ type: 'task.completed', taskId: 'task-b', status: 'done' });
    const eventC = firstStore.append({ type: 'task.completed', taskId: 'task-c', status: 'done' });
    // client-a acknowledges every event, so it must see nothing after restart.
    firstStore.ack('client-a', eventA.eventId);
    firstStore.ack('client-a', eventB.eventId);
    firstStore.ack('client-a', eventC.eventId);
    // client-b never acknowledges, so it must still see all events after restart.

    const restarted = new TaskEventStore({ persistencePath: eventsPath });
    assert.deepStrictEqual(
      restarted.list({ clientId: 'client-a' }).events.map(event => event.taskId),
      [],
      'fully acknowledged client must not replay old events'
    );
    assert.deepStrictEqual(
      restarted.list({ clientId: 'client-b' }).events.map(event => event.taskId),
      ['task-a', 'task-b', 'task-c'],
      'unacknowledged client must still see retained events'
    );
    // A brand-new client must see the full retained window.
    assert.deepStrictEqual(
      restarted.list({ clientId: 'client-c' }).events.map(event => event.taskId),
      ['task-a', 'task-b', 'task-c']
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskEventStore pruning does not make a retained client cursor replay another task', () => {
  const dir = makeTempDir();
  const eventsPath = path.join(dir, 'events.json');
  try {
    const store = new TaskEventStore({ persistencePath: eventsPath, maxEvents: 3 });
    const first = store.append({ type: 'task.completed', taskId: 'task-original', status: 'done' });
    store.ack('slow-client', first.eventId);
    // Push enough events to prune the acknowledged one. Each event belongs to
    // a different task so a cursor bug would surface as another task's event
    // being replayed under the slow client's acknowledged position.
    store.append({ type: 'task.completed', taskId: 'task-second', status: 'done' });
    store.append({ type: 'task.completed', taskId: 'task-third', status: 'done' });
    store.append({ type: 'task.completed', taskId: 'task-fourth', status: 'done' });

    const listed = store.list({ clientId: 'slow-client' });
    assert.deepStrictEqual(
      listed.events.map(event => event.taskId),
      ['task-second', 'task-third', 'task-fourth'],
      'pruned acknowledged cursor must not replay another task or skip retained events'
    );
    assert.strictEqual(listed.hasMore, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskEventStore long-poll wakes for a new event after restart with a future cursor', async () => {
  const dir = makeTempDir();
  const eventsPath = path.join(dir, 'events.json');
  try {
    // A restarted store with no retained events. A client connects with a
    // cursor ahead of the current sequence (e.g. it crashed after receiving
    // a future cursor). The long-poll must still wake when a new event is
    // appended instead of stalling forever.
    const restarted = new TaskEventStore({ persistencePath: eventsPath });
    const waiting = restarted.wait({ clientId: 'future-after-restart', after: 'evt_999', timeoutMs: 800 });
    setTimeout(() => {
      restarted.append({ type: 'task.completed', taskId: 'task-after-restart', status: 'done' });
    }, 20);

    const result = await waiting;
    assert.deepStrictEqual(
      result.events.map(event => event.taskId),
      ['task-after-restart'],
      'future cursor must reset to the retained window so the next event still wakes the long-poll'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskOrchestrator resolveIdempotentTask returns null for an unknown key without touching the queue', () => {
  const history = newHistoryStore(path.join(os.tmpdir(), `traecn-history-${Date.now()}.json`));
  const queue = new Map();
  const service = newQueueService(null, { taskHistoryStore: history });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  try {
    assert.strictEqual(orchestrator.resolveIdempotentTask('never-seen-key'), null);
    assert.strictEqual(queue.size, 0);
  } finally {
    service.close();
  }
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
})();
