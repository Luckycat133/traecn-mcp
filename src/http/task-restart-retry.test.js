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
const { Readable } = require('stream');

const { TaskQueueService } = require('./task-queue-service');
const { TaskOrchestrator } = require('./task-orchestrator');
const { TaskEventStore } = require('../shared/task-event-store');
const { TaskHistoryStore } = require('../shared/task-history');
const { Gateway } = require('./gateway');
const { CompletionSignal } = require('./completion-signal');
const { BatchExecutor } = require('./batch-executor');
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

function newQueueService(persistencePath, {
  taskHistoryStore,
  onWritePhase,
  isCancellationConfirmed,
  isTaskFinalizationConfirmed,
  terminalReplayTtlMs,
  now
} = {}) {
  return new TaskQueueService({
    logger: { error() {}, warn() {}, log() {} },
    persistencePath,
    taskHistoryStore,
    isTerminalStatus,
    onWritePhase,
    isCancellationConfirmed,
    isTaskFinalizationConfirmed,
    terminalReplayTtlMs,
    now
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
    modelProbeIntervalMs: value => new BatchExecutor().modelProbeIntervalMs(value),
    normalizeAutoApproveDialog: (value) => value || null,
    normalizeSoloChatTarget: (value) => value || null,
    syncTaskHistoryMirror: () => {},
    isTerminalStatus,
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

function lifecycleGateway({ history, queue, service, orchestrator, events }) {
  const gateway = Object.create(Gateway.prototype);
  return Object.assign(gateway, {
    taskQueue: queue,
    taskQueueService: service,
    taskLocks: service.taskLocks,
    taskOrchestrator: orchestrator,
    taskHistoryStore: history,
    sessions: new Map(),
    wsHandler: null,
    completionSignal: new CompletionSignal({ getTaskEventStore: () => events }),
    taskEventStore: events,
    _syncTaskHistoryMirror: task => service.syncHistoryMirror(task),
    _persistActiveQueue: () => service.persist(queue),
    _json: (_req, _res, body) => body
  });
}

async function dispatchTaskAction(gateway, taskId, action, body = null) {
  Object.assign(gateway, {
    _checkOrigin: () => true,
    _authenticate: () => true,
    _checkRateLimit: () => true,
    _checkIdempotency: () => null,
    _finishRequestLog: () => {},
    _json: (_req, res, body, statusCode = 200) => {
      Object.assign(res, { statusCode, body });
    }
  });
  const response = {};
  const request = body === null ? {} : Readable.from([JSON.stringify(body)]);
  Object.assign(request, {
    method: 'POST', url: `/api/task/${taskId}/${action}`, headers: { host: 'localhost' }
  });
  await gateway._handleRequestImpl(request, response);
  return response;
}

function dispatchCancellation(gateway, taskId) {
  return dispatchTaskAction(gateway, taskId, 'cancel');
}

function storageOnlyPolling(gateway, calls) {
  let runProbe;
  gateway._setInterval = callback => { runProbe = callback; return { unref() {} }; };
  gateway._ensureConnection = async () => { calls.connection++; };
  gateway._withUiActionLock = callback => callback();
  gateway.driver = Object.fromEntries(['sendMessage', 'collectResponse', 'newChat', 'checkQueueStatus'].map(name => [name, async () => {
    calls.model++;
    throw new Error(`unexpected ${name} during persistence retry`);
  }]));
  gateway._ensureBackgroundPolling();
  return () => runProbe();
}

function stateEventProof(events) {
  return (...args) => Gateway.prototype._hasConfirmedTaskStateEvent.call({ taskEventStore: events }, ...args);
}

const STATE_EVENT_TYPES = {
  done: 'task.completed', error: 'task.error', review_rejected: 'task.review_rejected',
  queue_timeout: 'task.queue_timeout', awaiting_review: 'task.review_required',
  approval_required: 'task.approval_required'
};

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

test('terminal idempotency replay survives restart with the original result', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  const request = {
    task: 'durable terminal replay task',
    sessionId: 'session-terminal-replay',
    idempotencyKey: 'terminal-durable-key'
  };
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, { taskHistoryStore: history });
    const orchestrator = newOrchestrator({
      taskHistoryStore: history,
      taskQueueService: service,
      taskQueue: queue
    });
    const task = orchestrator.createQueuedTask(request, {
      queued: false,
      running: false,
      canSubmit: true
    });
    task.status = 'done';
    task.result = { text: 'original terminal answer', stable: true };
    task.completedAt = '2026-08-08T12:00:00.000Z';

    assert.strictEqual(orchestrator.recordTerminalTask(task), true);
    service.close();

    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, { taskHistoryStore: history });
    restoredService.restore(restoredQueue);
    const restoredOrchestrator = newOrchestrator({
      taskHistoryStore: history,
      taskQueueService: restoredService,
      taskQueue: restoredQueue
    });
    const replay = restoredOrchestrator.resolveIdempotentTask(
      'terminal-durable-key',
      request
    );

    assert.deepStrictEqual(replay, {
      taskId: task.taskId,
      status: 'done',
      result: { text: 'original terminal answer', stable: true },
      error: null,
      terminal: true,
      statusCode: 200
    });
    assert.strictEqual(restoredQueue.size, 0);
    restoredService.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('cancellation is durable before driver stop returns and cannot be undone by late work', async () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  const eventsPath = path.join(dir, 'events.json');
  const history = newHistoryStore(historyPath);
  const queue = new Map();
  const service = newQueueService(queuePath, { taskHistoryStore: history });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: eventsPath });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let finishStop;
  const stopping = new Promise(resolve => { finishStop = resolve; });
  let stopCalls = 0;
  gateway.driver = {
    stopGeneration() { stopCalls++; return stopping; }
  };
  const request = { task: 'work that will be cancelled', idempotencyKey: 'cancel-replay-key' };
  const task = orchestrator.createQueuedTask(request);
  task.status = 'executing';
  task.submittedToTrae = true;
  task.attempts = 0;
  task.result = { text: 'partial result', stable: false };
  service.tryAcquire(task.taskId);
  const cancellation = gateway._handleTaskCancel({}, {}, task.taskId);
  let assertionError;
  let concurrentCancellation;
  try {
    assert.strictEqual(task.status, 'cancelled', 'persist cancellation before waiting for the driver');
    assert.strictEqual(task.cancelRequested, true);
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')).terminalReplays[0].status, 'cancelled');

    await gateway._finalizeCollectedBackgroundResult(task.taskId, task, {
      text: 'A late result must not replace cancellation.', stable: true
    });
    assert.strictEqual(await gateway._retryBackgroundTaskAfterError(task.taskId, task, new Error('stop interrupted collect')), false);
    await gateway._finalizeBackgroundTask(task.taskId, task, 'error', { error: 'late failure' });
    concurrentCancellation = gateway._finalizeBackgroundTask(task.taskId, task, 'cancelled');
    assert.strictEqual(task.status, 'cancelled');
    assert.strictEqual(task.attempts, 0);
    assert.deepStrictEqual(task.result, { text: 'partial result', stable: false });
    assert.deepStrictEqual(events.list().events.map(event => event.type), ['task.cancelled']);
  } catch (error) {
    assertionError = error;
  } finally {
    finishStop({ success: true });
    await Promise.all([cancellation, concurrentCancellation]);
    service.close();
    history.shutdown();
  }

  try {
    if (assertionError) throw assertionError;
    const restartedQueue = new Map();
    const restartedService = newQueueService(queuePath);
    try {
      assert.strictEqual(restartedService.restore(restartedQueue), 0);
      const restartedOrchestrator = newOrchestrator({
        taskHistoryStore: history,
        taskQueueService: restartedService,
        taskQueue: restartedQueue
      });
      assert.deepStrictEqual(restartedOrchestrator.resolveIdempotentTask('cancel-replay-key', request), {
        taskId: task.taskId,
        status: 'cancelled',
        result: { text: 'partial result', stable: false },
        error: null,
        terminal: true,
        statusCode: 200
      });
      const restartedEvents = new TaskEventStore({ persistencePath: eventsPath });
      assert.deepStrictEqual(restartedEvents.list().events.map(event => event.type), ['task.cancelled']);
    } finally {
      restartedService.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('queued task cancelled during preparation is never submitted or requeued', async () => {
  const dir = makeTempDir();
  const history = newHistoryStore(path.join(dir, 'history.json'));
  const queue = new Map();
  const service = newQueueService(path.join(dir, 'queue.json'), { taskHistoryStore: history });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let runProbe;
  let sends = 0;
  gateway._setInterval = callback => { runProbe = callback; return { unref() {} }; };
  gateway._ensureConnection = async () => {};
  gateway._withUiActionLock = callback => callback();
  gateway.driver = {
    checkQueueStatus: async () => ({ queued: false, running: false }),
    newChat: async () => {},
    sendMessage: async () => { sends++; },
    collectResponse: async () => ({ text: 'A queued cancelled task must never reach this result.', stable: true })
  };
  const task = orchestrator.createQueuedTask({ task: 'cancel before submission', idempotencyKey: 'cancel-before-send' });
  gateway._prepareQueuedTask = async () => { await gateway._handleTaskCancel({}, {}, task.taskId); };
  try {
    gateway._ensureBackgroundPolling();
    await runProbe();
    assert.strictEqual(task.status, 'cancelled');
    assert.strictEqual(task.submittedToTrae, false);
    assert.strictEqual(sends, 0);
    assert.deepStrictEqual(events.list().events.map(event => event.type), ['task.cancelled']);
  } finally {
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('non-idempotent cancellation retains its durable identity until native stop finishes', async () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'queue.json');
  const history = newHistoryStore(path.join(dir, 'history.json'));
  const queue = new Map();
  const service = newQueueService(queuePath, { taskHistoryStore: history });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let finishStop;
  gateway.driver = { stopGeneration: () => new Promise(resolve => { finishStop = resolve; }) };
  const task = orchestrator.createQueuedTask({ task: 'cancellable work without an idempotency key' });
  task.status = 'executing';
  task.submittedToTrae = true;
  assert.strictEqual(service.persist(queue), true);
  const cancellation = gateway._handleTaskCancel({}, {}, task.taskId);
  try {
    assert.strictEqual(task.status, 'cancelled');
    const committingTask = JSON.parse(fs.readFileSync(queuePath, 'utf8')).tasks[0];
    assert.strictEqual(committingTask.taskId, task.taskId);
    assert.strictEqual(committingTask.status, 'cancelled');
    assert.strictEqual(committingTask.cancelPersistencePending.previousStatus, 'executing');
    assert.deepStrictEqual(events.list().events.map(event => event.type), ['task.cancelled']);
    service.close();
    const restartedService = newQueueService(queuePath, {
      isCancellationConfirmed: taskId => events.events.some(event => event.taskId === taskId && event.type === 'task.cancelled')
    });
    try {
      const restartedQueue = new Map();
      assert.strictEqual(restartedService.restore(restartedQueue), 1);
      assert.strictEqual(restartedQueue.get(task.taskId).cancelPersistencePending.previousStatus, 'executing');
      assert.strictEqual(restartedQueue.get(task.taskId).stopResult, undefined);
    } finally {
      restartedService.close();
    }
  } finally {
    finishStop({ success: true });
    await cancellation;
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('failed cancellation before commit returns HTTP 503, preserves active work, and can be retried', async () => {
  for (const [status, withKey] of [['queued', true], ['executing', true], ['approval_required', true], ['executing', false]]) {
    const dir = makeTempDir();
    const queuePath = path.join(dir, 'queue.json');
    const history = newHistoryStore(path.join(dir, 'history.json'));
    const queue = new Map();
    let failWrites = false;
    const service = newQueueService(queuePath, {
      taskHistoryStore: history,
      onWritePhase(phase) {
        if (!failWrites || phase !== 'temp_opened') return;
        throw Object.assign(new Error('injected cancellation ENOSPC'), { code: 'ENOSPC' });
      }
    });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
    const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
    let stopCalls = 0;
    let sessionWrites = 0;
    let statusNotifications = 0;
    gateway.driver = { stopGeneration: async () => { stopCalls++; return { success: true }; } };
    gateway._appendSessionMessage = () => { sessionWrites++; return true; };
    gateway.wsHandler = { notifyTaskStatusChange: () => { statusNotifications++; } };
    const request = { task: 'cancel only after durable commit', sessionId: 'cancel-session', ...(withKey ? { idempotencyKey: 'cancel-fault-key' } : {}) };
    const task = orchestrator.createQueuedTask(request);
    task.status = status;
    task.submittedToTrae = status === 'executing';
    task.error = 'preexisting detail';
    task.result = { text: 'original partial response' };
    if (status === 'approval_required') task.interactionRequestId = 'interaction-before-cancel';
    service.syncHistoryMirror(task);
    assert.strictEqual(service.persist(queue), true);
    const originalTask = structuredClone(task);
    const originalHistory = structuredClone(history.getTask(task.taskId));
    service.tryAcquire(task.taskId);
    try {
      failWrites = true;
      const failed = await dispatchCancellation(gateway, task.taskId);
      assert.strictEqual(failed.statusCode, 503, status);
      assert.strictEqual(failed.body.code, 'TASK_STORE_UNAVAILABLE');
      assert.strictEqual(service.getPersistenceHealth().lastPersistError.snapshotCommitted, false);
      assert.deepStrictEqual(task, originalTask, 'failed cancel must restore every original task field');
      assert.deepStrictEqual(history.getTask(task.taskId), originalHistory);
      assert.strictEqual(service.taskLocks.has(task.taskId), true);
      assert.strictEqual(stopCalls, 0);
      assert.strictEqual(sessionWrites, 0);
      assert.strictEqual(statusNotifications, 0);
      assert.deepStrictEqual(events.list().events, []);
      assert.strictEqual(service.getTerminalReplay(request.idempotencyKey), null);

      service.close();
      const restartedService = newQueueService(queuePath);
      try {
        const restoredQueue = new Map();
        assert.strictEqual(restartedService.restore(restoredQueue), 1);
        assert.strictEqual(restoredQueue.get(task.taskId).status, status);
        assert.strictEqual(restartedService.getTerminalReplay(request.idempotencyKey), null);
      } finally {
        restartedService.close();
      }

      failWrites = false;
      const retried = await dispatchCancellation(gateway, task.taskId);
      assert.strictEqual(retried.statusCode, 200);
      assert.strictEqual(task.status, 'cancelled');
      assert.strictEqual(task.cancelRequested, true);
      assert.strictEqual(stopCalls, status === 'executing' ? 1 : 0);
      assert.strictEqual(service.taskLocks.has(task.taskId), false);
      assert.strictEqual(sessionWrites, 1);
      assert.strictEqual(statusNotifications, 1);
      assert.deepStrictEqual(events.list().events.map(event => event.type), ['task.cancelled']);
      const snapshot = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      assert.deepStrictEqual(snapshot.tasks, []);
      assert.strictEqual(snapshot.terminalReplays.length, withKey ? 1 : 0);
      if (withKey) assert.strictEqual(snapshot.terminalReplays[0].status, 'cancelled');
    } finally {
      service.close();
      history.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

asyncTest('cancellation interrupted after rename keeps the committed state and retries without duplicate delivery', async () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'queue.json');
  const history = newHistoryStore(path.join(dir, 'history.json'));
  const queue = new Map();
  let failurePhase = null;
  const service = newQueueService(queuePath, {
    taskHistoryStore: history,
    onWritePhase(phase) {
      if (phase !== failurePhase) return;
      throw Object.assign(new Error('injected cancellation EIO'), { code: 'EIO' });
    }
  });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let stopCalls = 0;
  gateway.driver = { stopGeneration: async () => { stopCalls++; return { success: true }; } };
  const task = orchestrator.createQueuedTask({ task: 'cancel interrupted commit', idempotencyKey: 'cancel-post-rename' });
  task.status = 'executing';
  task.submittedToTrae = true;
  service.syncHistoryMirror(task);
  assert.strictEqual(service.persist(queue), true);
  const originalHistory = structuredClone(history.getTask(task.taskId));
  try {
    failurePhase = 'primary_committed';
    const failed = await dispatchCancellation(gateway, task.taskId);
    assert.strictEqual(failed.statusCode, 503);
    assert.match(failed.body.error, /could not be confirmed/);
    assert.strictEqual(service.getPersistenceHealth().lastPersistError.snapshotCommitted, true);
    assert.strictEqual(task.status, 'cancelled');
    assert.deepStrictEqual(task.cancelPersistencePending, { previousStatus: 'executing' });
    const statusResponse = {};
    await gateway._handleTaskStatus({ url: `/api/task/${task.taskId}`, headers: { host: 'localhost' } }, statusResponse, task.taskId);
    assert.strictEqual(statusResponse.body.status, 'executing', 'unconfirmed cancellation is not a terminal wire status');
    assert.strictEqual(statusResponse.body.cancelPersistencePending, true);
    assert.strictEqual(service.getTerminalReplay('cancel-post-rename').status, 'cancelled');
    const committingTask = JSON.parse(fs.readFileSync(queuePath, 'utf8')).tasks[0];
    assert.strictEqual(committingTask.taskId, task.taskId);
    assert.strictEqual(committingTask.cancelPersistencePending.previousStatus, 'executing');
    assert.strictEqual(stopCalls, 0);
    assert.deepStrictEqual(events.list().events, []);
    assert.deepStrictEqual(history.getTask(task.taskId), originalHistory);
    await gateway._finalizeBackgroundTask(task.taskId, task, 'done', { result: { text: 'late completed work' } });
    assert.strictEqual(task.status, 'cancelled', 'uncertain durability must not allow late completion to resume work');

    failurePhase = 'temp_opened';
    assert.strictEqual((await dispatchCancellation(gateway, task.taskId)).statusCode, 503);
    assert.deepStrictEqual(task.cancelPersistencePending, { previousStatus: 'executing' });
    assert.strictEqual(stopCalls, 0);
    assert.deepStrictEqual(events.list().events, []);

    failurePhase = null;
    assert.strictEqual((await dispatchCancellation(gateway, task.taskId)).statusCode, 200);
    assert.strictEqual(task.cancelPersistencePending, undefined);
    assert.strictEqual(stopCalls, 1);
    assert.deepStrictEqual(events.list().events.map(event => event.type), ['task.cancelled']);
    service.close();
    const restartedService = newQueueService(queuePath);
    try {
      assert.strictEqual(restartedService.restore(new Map()), 0);
      assert.strictEqual(restartedService.getTerminalReplay('cancel-post-rename').status, 'cancelled');
    } finally {
      restartedService.close();
    }
  } finally {
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('unconfirmed cancellation survives restart with its original identity and can be retried with or without a key', async () => {
  for (const [status, withKey] of [['executing', true], ['executing', false], ['approval_required', true], ['awaiting_review', false]]) {
    const dir = makeTempDir();
    const queuePath = path.join(dir, 'queue.json');
    const historyPath = path.join(dir, 'history.json');
    const eventsPath = path.join(dir, 'events.json');
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    let failAfterRename = false;
    const service = newQueueService(queuePath, {
      taskHistoryStore: history,
      onWritePhase(phase) {
        if (failAfterRename && phase === 'primary_committed') {
          throw Object.assign(new Error('injected cancellation EIO before restart'), { code: 'EIO' });
        }
      }
    });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const events = new TaskEventStore({ persistencePath: eventsPath });
    const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
    let stopCalls = 0;
    let sendCalls = 0;
    let collectCalls = 0;
    const driver = {
      stopGeneration: async () => { stopCalls++; return { success: true }; },
      getActiveSoloChat: async () => ({ active: { sessionId: 'original-cancelled-session' } }),
      sendMessage: async () => { sendCalls++; },
      collectResponse: async () => { collectCalls++; },
      checkQueueStatus: async () => ({ queued: false, running: false })
    };
    gateway.driver = driver;
    const request = { task: 'retry original cancellation after process restart', ...(withKey ? { idempotencyKey: 'pending-after-restart' } : {}) };
    const task = orchestrator.createQueuedTask(request);
    task.status = status;
    task.submittedToTrae = status === 'executing';
    task.soloChat = { sessionId: 'original-cancelled-session' };
    if (status === 'approval_required') task.interactionRequestId = 'original-command-interaction';
    service.syncHistoryMirror(task);
    assert.strictEqual(service.persist(queue), true);
    let restartedService;
    let restartedHistory;
    try {
      failAfterRename = true;
      assert.strictEqual((await dispatchCancellation(gateway, task.taskId)).statusCode, 503);
      assert.strictEqual(stopCalls, 0);
      assert.deepStrictEqual(events.list().events, []);
      if (withKey) {
        assert.throws(() => orchestrator.resolveIdempotentTask(request.idempotencyKey, request), error => error.code === 'TASK_STORE_UNAVAILABLE');
      }
      service.close();
      history.shutdown();

      restartedHistory = newHistoryStore(historyPath);
      const restartedEvents = new TaskEventStore({ persistencePath: eventsPath });
      const restartedQueue = new Map();
      restartedService = newQueueService(queuePath, { taskHistoryStore: restartedHistory });
      assert.strictEqual(restartedService.restore(restartedQueue), 1);
      const restoredTask = restartedQueue.get(task.taskId);
      assert.ok(restoredTask, 'keep the original cancellation endpoint after restart');
      assert.strictEqual(restoredTask.status, 'cancelled', 'internal cancellation blocks background execution');
      assert.strictEqual(restoredTask.cancelPersistencePending.previousStatus, status);
      assert.strictEqual(restartedHistory.getTask(task.taskId).status, status);
      const restartedOrchestrator = newOrchestrator({ taskHistoryStore: restartedHistory, taskQueueService: restartedService, taskQueue: restartedQueue });
      const restartedGateway = lifecycleGateway({ history: restartedHistory, queue: restartedQueue, service: restartedService, orchestrator: restartedOrchestrator, events: restartedEvents });
      restartedGateway._ensureConnection = async () => { restartedGateway.driver = driver; };
      const statusResponse = {};
      restartedGateway._json = (_req, res, body) => { res.body = body; };
      await restartedGateway._handleTaskStatus({ url: `/api/task/${task.taskId}`, headers: { host: 'localhost' } }, statusResponse, task.taskId);
      assert.strictEqual(statusResponse.body.status, status);
      assert.strictEqual(statusResponse.body.cancelPersistencePending, true);
      if (withKey) {
        assert.throws(() => restartedOrchestrator.resolveIdempotentTask(request.idempotencyKey, request), error => error.code === 'TASK_STORE_UNAVAILABLE');
      }
      let runProbe;
      restartedGateway._setInterval = callback => { runProbe = callback; return { unref() {} }; };
      restartedGateway._withUiActionLock = callback => callback();
      restartedGateway._ensureBackgroundPolling();
      await runProbe();
      assert.strictEqual(sendCalls, 0);
      assert.strictEqual(collectCalls, 0);
      assert.strictEqual(stopCalls, 0);
      assert.strictEqual((await dispatchCancellation(restartedGateway, task.taskId)).statusCode, 200);
      assert.strictEqual(stopCalls, status === 'executing' ? 1 : 0);
      assert.strictEqual(restartedQueue.size, 1, 'retry must not create another task identity');
      assert.strictEqual(restoredTask.cancelPersistencePending, undefined);
      assert.deepStrictEqual(restartedEvents.list().events.map(event => event.type), ['task.cancelled']);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')).tasks, []);
      assert.strictEqual((await dispatchCancellation(restartedGateway, task.taskId)).statusCode, 400);
      assert.strictEqual(stopCalls, status === 'executing' ? 1 : 0);
      assert.strictEqual(restartedEvents.list().events.length, 1);
    } finally {
      service.close();
      restartedService?.close();
      history.shutdown();
      restartedHistory?.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

asyncTest('a durable cancellation stop checkpoint suppresses pending recovery after final snapshot cleanup fails', async () => {
  for (const withKey of [true, false]) {
    const dir = makeTempDir();
    const queuePath = path.join(dir, 'queue.json');
    const historyPath = path.join(dir, 'history.json');
    const eventsPath = path.join(dir, 'events.json');
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    let failCleanup = false;
    const service = newQueueService(queuePath, {
      taskHistoryStore: history,
      onWritePhase(phase) {
        if (failCleanup && phase === 'temp_opened') {
          throw Object.assign(new Error('injected cancellation cleanup ENOSPC'), { code: 'ENOSPC' });
        }
      }
    });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const events = new TaskEventStore({ persistencePath: eventsPath });
    const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
    let stopCalls = 0;
    gateway.driver = { stopGeneration: async () => { stopCalls++; return { success: true }; } };
    const emit = gateway._emitTaskNotification.bind(gateway);
    gateway._emitTaskNotification = async (...args) => {
      const result = await emit(...args);
      assert.deepStrictEqual(args[1].stopResult, { success: true });
      assert.strictEqual(service.persist(queue), true, 'persist native stop proof before injecting final cleanup failure');
      failCleanup = true;
      return result;
    };
    const task = orchestrator.createQueuedTask({ task: 'completed cancellation with failed cleanup', ...(withKey ? { idempotencyKey: 'cleanup-fault-key' } : {}) });
    task.status = 'executing';
    task.submittedToTrae = true;
    service.syncHistoryMirror(task);
    assert.strictEqual(history._persistNow(), true);
    const originalHistoryBytes = fs.readFileSync(historyPath);
    try {
      assert.strictEqual((await dispatchCancellation(gateway, task.taskId)).statusCode, 200, 'the initial cancellation snapshot committed successfully');
      assert.strictEqual(stopCalls, 1);
      assert.strictEqual(events.list().events.length, 1);
      assert.strictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')).tasks[0].taskId, task.taskId);
      service.close();
      history.shutdown();
      // Simulate a crash before the history debounce flushed completion.
      fs.writeFileSync(historyPath, originalHistoryBytes);
      const restartedHistory = newHistoryStore(historyPath);
      assert.strictEqual(restartedHistory.getTask(task.taskId).status, 'executing');
      const restartedEvents = new TaskEventStore({ persistencePath: eventsPath });
      const restartedService = newQueueService(queuePath, {
        taskHistoryStore: restartedHistory,
        isCancellationConfirmed: taskId => restartedEvents.events.some(event => event.taskId === taskId && event.type === 'task.cancelled' && event.terminal)
      });
      try {
        assert.strictEqual(restartedService.restore(new Map()), 0, 'confirmed cancellations must not reappear as pending');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')).tasks, []);
        assert.strictEqual(restartedEvents.list().events.length, 1);
        assert.strictEqual(stopCalls, 1);
        assert.strictEqual(restartedHistory.getTask(task.taskId).status, 'cancelled', 'repair stale history from the durable cancellation event');
      } finally {
        restartedService.close();
        restartedHistory.shutdown();
      }
    } finally {
      service.close();
      history.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

asyncTest('late submission cannot stop generation before pending cancellation persistence is confirmed', async () => {
  const dir = makeTempDir();
  const history = newHistoryStore(path.join(dir, 'history.json'));
  const queue = new Map();
  let failAfterRename = false;
  const service = newQueueService(path.join(dir, 'queue.json'), {
    taskHistoryStore: history,
    onWritePhase(phase) {
      if (failAfterRename && phase === 'primary_committed') {
        throw Object.assign(new Error('injected cancellation EIO during send'), { code: 'EIO' });
      }
    }
  });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let runProbe;
  let startSending;
  let finishSending;
  let stopCalls = 0;
  let collectCalls = 0;
  const startedSending = new Promise(resolve => { startSending = resolve; });
  const sending = new Promise(resolve => { finishSending = resolve; });
  gateway._setInterval = callback => { runProbe = callback; return { unref() {} }; };
  gateway._ensureConnection = async () => {};
  gateway._withUiActionLock = callback => callback();
  gateway._prepareQueuedTask = async () => {};
  gateway.driver = {
    checkQueueStatus: async () => ({ queued: false, running: false }),
    newChat: async () => {},
    sendMessage: () => { startSending(); return sending; },
    stopGeneration: async () => { stopCalls++; return { success: true }; },
    collectResponse: async () => { collectCalls++; return { text: 'late work', stable: true }; }
  };
  const task = orchestrator.createQueuedTask({ task: 'cancel during async submission', idempotencyKey: 'cancel-during-send' });
  gateway._ensureBackgroundPolling();
  const probing = runProbe();
  try {
    await startedSending;
    failAfterRename = true;
    assert.strictEqual((await dispatchCancellation(gateway, task.taskId)).statusCode, 503);
    assert.strictEqual(task.cancelPersistencePending.previousStatus, 'executing');
    finishSending();
    await probing;
    assert.strictEqual(task.submittedToTrae, true);
    assert.strictEqual(stopCalls, 0);
    assert.strictEqual(collectCalls, 0);
    assert.deepStrictEqual(events.list().events, []);
    failAfterRename = false;
    assert.strictEqual((await dispatchCancellation(gateway, task.taskId)).statusCode, 200);
    assert.strictEqual(stopCalls, 1);
    assert.deepStrictEqual(events.list().events.map(event => event.type), ['task.cancelled']);
  } finally {
    finishSending();
    await probing;
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('finalization failures retain the captured state and retry storage without model work', async () => {
  for (const status of Object.keys(STATE_EVENT_TYPES)) {
    for (const [phase, withKey] of [['temp_opened', true], ['temp_opened', false], ['primary_committed', true], ['primary_committed', false]]) {
      const dir = makeTempDir();
      const queuePath = path.join(dir, 'queue.json');
      const historyPath = path.join(dir, 'history.json');
      const eventsPath = path.join(dir, 'events.json');
      let history = newHistoryStore(historyPath);
      let queue = new Map();
      let failWrites = false;
      const options = {
        onWritePhase(currentPhase) {
          if (failWrites && currentPhase === phase) {
            throw Object.assign(new Error(`injected ${status} state failure`), { code: 'EIO' });
          }
        }
      };
      let service = newQueueService(queuePath, { taskHistoryStore: history, ...options });
      let orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
      let events = new TaskEventStore({ persistencePath: eventsPath });
      let gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
      const request = { task: 'keep the selected result through storage failure', ...(withKey ? { idempotencyKey: 'state-retry-key' } : {}) };
      let task = orchestrator.createQueuedTask(request);
      const taskId = task.taskId;
      task.status = 'executing';
      task.submittedToTrae = true;
      service.syncHistoryMirror(task);
      assert.strictEqual(service.persist(queue), true);
      const result = { text: 'The complete captured response must survive storage retry without another model submission.', stable: true };
      try {
        failWrites = true;
        await assert.rejects(gateway._finalizeBackgroundTask(taskId, task, status, {
          result, error: ['error', 'queue_timeout'].includes(status) ? 'original outcome detail' : null
        }), error => error.code === 'TASK_STORE_UNAVAILABLE');
        assert.deepStrictEqual(task.statePersistencePending, { previousStatus: 'executing', status });
        assert.deepStrictEqual(task.result, result);
        assert.deepStrictEqual(events.list().events, []);
        assert.strictEqual(history.getTask(taskId).status, 'executing');
        const interactionId = task.interactionRequestId;

        if (phase === 'primary_committed') {
          service.close();
          history.shutdown();
          history = newHistoryStore(historyPath);
          events = new TaskEventStore({ persistencePath: eventsPath });
          queue = new Map();
          service = newQueueService(queuePath, { taskHistoryStore: history, isTaskFinalizationConfirmed: stateEventProof(events), ...options });
          assert.strictEqual(service.restore(queue), 1);
          task = queue.get(taskId);
          assert.deepStrictEqual(task.result, result);
          assert.strictEqual(task.interactionRequestId, interactionId);
          assert.strictEqual(history.getTask(taskId).status, 'executing');
          orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
          gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
        } else {
          const snapshot = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
          assert.strictEqual(snapshot.tasks[0].taskId, taskId);
          assert.strictEqual(snapshot.tasks[0].submittedToTrae, true, 'the last valid snapshot retains existing model submission identity');
        }
        if (withKey) {
          assert.throws(() => orchestrator.resolveIdempotentTask(request.idempotencyKey, request), error => error.code === 'TASK_STORE_UNAVAILABLE');
        }
        const readResponse = {};
        gateway._json = (_req, res, body) => { res.body = body; };
        await gateway._handleTaskStatus({ url: `/api/task/${taskId}`, headers: { host: 'localhost' } }, readResponse, taskId);
        assert.strictEqual(readResponse.body.status, 'executing');
        assert.strictEqual(readResponse.body.statePersistencePending, true);
        assert.deepStrictEqual(readResponse.body.result, result);
        const calls = { model: 0, connection: 0 };
        const runProbe = storageOnlyPolling(gateway, calls);
        await runProbe();
        assert.deepStrictEqual(calls, { model: 0, connection: 0 });
        assert.strictEqual(task.statePersistencePending.status, status);
        assert.deepStrictEqual(task.result, result);
        assert.deepStrictEqual(events.list().events, []);
        failWrites = false;
        await runProbe();
        assert.deepStrictEqual(calls, { model: 0, connection: 0 });
        assert.strictEqual(task.statePersistencePending, undefined);
        assert.strictEqual(task.status, status);
        assert.deepStrictEqual(task.result, result);
        assert.strictEqual(task.interactionRequestId, interactionId);
        assert.deepStrictEqual(events.list().events.map(event => event.type), [STATE_EVENT_TYPES[status]]);
        await runProbe();
        assert.strictEqual(events.list().events.length, 1);
      } finally {
        service.close();
        history.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

asyncTest('confirmed state events repair stale history after cleanup failure and retain live checkpoints', async () => {
  for (const status of Object.keys(STATE_EVENT_TYPES)) {
    const dir = makeTempDir();
    const queuePath = path.join(dir, 'queue.json');
    const historyPath = path.join(dir, 'history.json');
    const eventsPath = path.join(dir, 'events.json');
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    let failCleanup = false;
    const service = newQueueService(queuePath, {
      taskHistoryStore: history,
      onWritePhase(phase) {
        if (failCleanup && phase === 'temp_opened') throw Object.assign(new Error('injected state cleanup failure'), { code: 'ENOSPC' });
      }
    });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const events = new TaskEventStore({ persistencePath: eventsPath });
    const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
    const task = orchestrator.createQueuedTask({ task: 'confirmed outcome survives cleanup and history crash' });
    task.status = 'executing';
    task.submittedToTrae = true;
    service.syncHistoryMirror(task);
    history._persistNow();
    const oldHistory = fs.readFileSync(historyPath);
    const emit = gateway._emitTaskNotification.bind(gateway);
    gateway._emitTaskNotification = async (...args) => {
      const result = await emit(...args);
      failCleanup = true;
      return result;
    };
    const result = { text: 'The confirmed result remains available after restart.', stable: true };
    try {
      await gateway._finalizeBackgroundTask(task.taskId, task, status, { result, error: status === 'error' ? 'confirmed error detail' : null });
      assert.strictEqual(events.list().events.length, 1);
      assert.strictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')).tasks[0].statePersistencePending.status, status);
      service.close();
      history.shutdown();
      fs.writeFileSync(historyPath, oldHistory);
      const restartedHistory = newHistoryStore(historyPath);
      const restartedEvents = new TaskEventStore({ persistencePath: eventsPath });
      const restartedService = newQueueService(queuePath, { taskHistoryStore: restartedHistory, isTaskFinalizationConfirmed: stateEventProof(restartedEvents) });
      try {
        const restoredQueue = new Map();
        const checkpoint = status === 'approval_required' || status === 'awaiting_review';
        assert.strictEqual(restartedService.restore(restoredQueue), checkpoint ? 1 : 0);
        if (checkpoint) {
          const restoredTask = restoredQueue.get(task.taskId);
          assert.strictEqual(restoredTask.statePersistencePending, undefined);
          assert.strictEqual(restoredTask.status, status);
          assert.strictEqual(restoredTask.interactionRequestId, task.interactionRequestId);
          assert.deepStrictEqual(restoredTask.result, result);
        }
        const expectedHistoryStatus = { done: 'completed', error: 'failed', queue_timeout: 'failed', review_rejected: 'cancelled' }[status] || status;
        assert.strictEqual(restartedHistory.getTask(task.taskId).status, expectedHistoryStatus);
        assert.deepStrictEqual(restartedHistory.getTask(task.taskId).result, result);
        const restartedGateway = lifecycleGateway({ history: restartedHistory, queue: restoredQueue, service: restartedService, orchestrator, events: restartedEvents });
        const calls = { model: 0, connection: 0 };
        await storageOnlyPolling(restartedGateway, calls)();
        assert.deepStrictEqual(calls, { model: 0, connection: 0 });
        assert.strictEqual(restartedEvents.list().events.length, 1);
      } finally {
        restartedService.close();
        restartedHistory.shutdown();
      }
    } finally {
      service.close();
      history.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

asyncTest('review finalization commits one parent and child identity and reuses them on storage retry', async () => {
  for (const phase of ['temp_opened', 'primary_committed']) {
    const dir = makeTempDir();
    const queuePath = path.join(dir, 'queue.json');
    const historyPath = path.join(dir, 'history.json');
    const eventsPath = path.join(dir, 'events.json');
    let history = newHistoryStore(historyPath);
    let queue = new Map();
    let failWrites = false;
    const options = { onWritePhase(currentPhase) {
      if (failWrites && currentPhase === phase) throw Object.assign(new Error('injected parent finalization failure'), { code: 'ENOSPC' });
    } };
    let service = newQueueService(queuePath, { taskHistoryStore: history, ...options });
    let orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    let events = new TaskEventStore({ persistencePath: eventsPath });
    let gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
    let parent = orchestrator.createQueuedTask({ task: 'reviewed parent', followupTasks: [{ task: 'one selected child' }, { task: 'remaining child' }] });
    const parentId = parent.taskId;
    parent.status = 'awaiting_review';
    parent.result = { text: 'The original parent result is preserved throughout review persistence retry.', stable: true };
    service.syncHistoryMirror(parent);
    service.persist(queue);
    try {
      failWrites = true;
      const first = await dispatchTaskAction(gateway, parentId, 'review', { decision: 'approve', notes: 'selected review decision' });
      assert.strictEqual(first.statusCode, 503);
      const childId = parent.nextTaskId;
      assert.ok(childId);
      assert.strictEqual(queue.get(childId).workflowParentTaskId, parentId);
      assert.strictEqual(queue.size, 2);
      assert.deepStrictEqual(events.list().events, []);
      if (phase === 'primary_committed') {
        service.close();
        history.shutdown();
        history = newHistoryStore(historyPath);
        events = new TaskEventStore({ persistencePath: eventsPath });
        queue = new Map();
        service = newQueueService(queuePath, { taskHistoryStore: history, isTaskFinalizationConfirmed: stateEventProof(events), ...options });
        assert.strictEqual(service.restore(queue), 2);
        parent = queue.get(parentId);
        assert.strictEqual(parent.nextTaskId, childId);
        orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
        gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
      }
      const calls = { model: 0, connection: 0 };
      const runProbe = storageOnlyPolling(gateway, calls);
      await runProbe();
      assert.deepStrictEqual(calls, { model: 0, connection: 0 });
      assert.strictEqual(queue.get(parentId).statePersistencePending.status, 'done');
      assert.strictEqual((await dispatchTaskAction(gateway, parentId, 'review', { decision: 'reject', notes: 'different decision' })).statusCode, 409);
      service.tryAcquire(childId);
      failWrites = false;
      const retried = await dispatchTaskAction(gateway, parentId, 'review', { decision: 'approve', notes: 'selected review decision' });
      assert.strictEqual(retried.statusCode, 200);
      assert.strictEqual(retried.body.status, 'continued');
      assert.strictEqual(retried.body.nextTaskId, childId);
      assert.strictEqual(retried.body.remainingFollowups, 1);
      assert.strictEqual(queue.size, 2);
      await runProbe();
      assert.deepStrictEqual(calls, { model: 0, connection: 0 });
      assert.deepStrictEqual(events.list().events.map(event => [event.taskId, event.type]), [[parentId, 'task.completed']]);
      assert.deepStrictEqual(parent.followupTasks.map(item => item.task), ['one selected child', 'remaining child']);
    } finally {
      service.close();
      history.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

asyncTest('a previous checkpoint event cannot confirm a new interaction after restart', async () => {
  for (const status of ['approval_required', 'awaiting_review']) {
    const dir = makeTempDir();
    const queuePath = path.join(dir, 'queue.json');
    const history = newHistoryStore(path.join(dir, 'history.json'));
    const queue = new Map();
    let failWrites = false;
    const service = newQueueService(queuePath, { taskHistoryStore: history, onWritePhase(phase) {
      if (failWrites && phase === 'primary_committed') throw Object.assign(new Error('new checkpoint EIO'), { code: 'EIO' });
    } });
    const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const eventsPath = path.join(dir, 'events.json');
    const events = new TaskEventStore({ persistencePath: eventsPath });
    const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
    const task = orchestrator.createQueuedTask({ task: 'repeated interaction task' });
    task.status = 'executing';
    task.submittedToTrae = true;
    try {
      await gateway._finalizeBackgroundTask(task.taskId, task, status, { result: { text: 'first checkpoint', stable: true } });
      const oldInteractionId = task.interactionRequestId;
      task.status = 'executing';
      delete task.interactionRequestId;
      service.persist(queue);
      failWrites = true;
      await assert.rejects(gateway._finalizeBackgroundTask(task.taskId, task, status, { result: { text: 'new checkpoint', stable: true } }), error => error.code === 'TASK_STORE_UNAVAILABLE');
      const newInteractionId = task.interactionRequestId;
      assert.notStrictEqual(newInteractionId, oldInteractionId);
      assert.strictEqual(events.events[0].interactionRequestId, oldInteractionId);
      service.close();
      const restartedEvents = new TaskEventStore({ persistencePath: eventsPath });
      const restartedService = newQueueService(queuePath, { taskHistoryStore: history, isTaskFinalizationConfirmed: stateEventProof(restartedEvents) });
      try {
        const restoredQueue = new Map();
        assert.strictEqual(restartedService.restore(restoredQueue), 1);
        const restoredTask = restoredQueue.get(task.taskId);
        assert.strictEqual(restoredTask.statePersistencePending.status, status);
        const restoredOrchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: restartedService, taskQueue: restoredQueue });
        const restoredGateway = lifecycleGateway({ history, queue: restoredQueue, service: restartedService, orchestrator: restoredOrchestrator, events: restartedEvents });
        const calls = { model: 0, connection: 0 };
        await storageOnlyPolling(restoredGateway, calls)();
        assert.deepStrictEqual(calls, { model: 0, connection: 0 });
        assert.strictEqual(restoredTask.interactionRequestId, newInteractionId);
        assert.deepStrictEqual(restartedEvents.events.map(event => event.interactionRequestId), [oldInteractionId, newInteractionId]);
      } finally {
        restartedService.close();
      }
    } finally {
      service.close();
      history.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

asyncTest('failed event writes retain each candidate until its original event can be confirmed', async () => {
  for (const status of [...Object.keys(STATE_EVENT_TYPES), 'cancelled']) {
    for (const phase of ['temp_opened', 'primary_committed']) {
      for (const restart of [false, true]) {
        const dir = makeTempDir();
        const queuePath = path.join(dir, 'queue.json');
        const historyPath = path.join(dir, 'history.json');
        const eventsPath = path.join(dir, 'events.json');
        let history = newHistoryStore(historyPath);
        let queue = new Map();
        let service = newQueueService(queuePath, { taskHistoryStore: history });
        let orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
        let failEvents = true;
        let events = new TaskEventStore({
          persistencePath: eventsPath,
          logger: { error() {}, warn() {} },
          onWritePhase(current) {
            if (failEvents && current === phase) throw Object.assign(new Error('injected event EIO'), { code: 'EIO' });
          }
        });
        let gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
        let deliveries = 0;
        let stopCalls = 0;
        const setSignal = () => {
          gateway.completionSignal = new CompletionSignal({
            getTaskEventStore: () => events,
            getWebSocketHandler: () => ({ broadcastEvent() { deliveries++; } }),
            logger: { error() {} }
          });
        };
        setSignal();
        gateway.driver = { stopGeneration: async () => { stopCalls++; return { success: true }; } };
        const request = { task: `event retry ${status}`, ...(restart ? {} : { idempotencyKey: `event-${status}` }) };
        let task = orchestrator.createQueuedTask(request);
        const taskId = task.taskId;
        task.status = 'executing';
        task.submittedToTrae = true;
        service.syncHistoryMirror(task);
        assert.strictEqual(service.persist(queue), true);
        const result = { text: `captured ${status} result`, stable: true };
        try {
          await assert.rejects(gateway._finalizeBackgroundTask(taskId, task, status, {
            result, error: status === 'error' ? 'original error' : null,
            ...(status === 'cancelled' ? { cancelRequested: true } : {})
          }), error => error.code === 'TASK_STORE_UNAVAILABLE');
          assert.deepStrictEqual(task.statePersistencePending, { previousStatus: 'executing', status });
          assert.strictEqual(history.getTask(taskId).status, 'executing');
          assert.strictEqual(deliveries, 0);
          assert.strictEqual(stopCalls, status === 'cancelled' ? 1 : 0);
          assert.strictEqual(events.events.length, 0);
          const saved = JSON.parse(fs.readFileSync(queuePath, 'utf8')).tasks.find(item => item.taskId === taskId);
          assert.deepStrictEqual(saved.result, result);
          assert.deepStrictEqual(saved.statePersistencePending, task.statePersistencePending);
          const interactionRequestId = task.interactionRequestId;
          const wire = await gateway._handleTaskStatus({ url: `/api/task/${taskId}` }, {}, taskId);
          assert.strictEqual(wire.status, 'executing');
          assert.strictEqual(wire.statePersistencePending, true);
          if (status === 'cancelled') assert.strictEqual(wire.cancelPersistencePending, true);
          if (request.idempotencyKey) assert.throws(() => orchestrator.resolveIdempotentTask(request.idempotencyKey, request), error => error.code === 'TASK_STORE_UNAVAILABLE');

          failEvents = false;
          let alreadyConfirmed = false;
          if (restart) {
            service.close();
            history.shutdown();
            history = newHistoryStore(historyPath);
            events = new TaskEventStore({ persistencePath: eventsPath });
            alreadyConfirmed = phase === 'primary_committed';
            queue = new Map();
            service = newQueueService(queuePath, {
              taskHistoryStore: history,
              isCancellationConfirmed: taskId => events.events.some(event => event.taskId === taskId && event.type === 'task.cancelled'),
              isTaskFinalizationConfirmed: stateEventProof(events)
            });
            const restored = service.restore(queue);
            const terminal = isTerminalStatus(status);
            assert.strictEqual(restored, alreadyConfirmed && terminal ? 0 : 1);
            task = queue.get(taskId) || task;
            orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
            gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
            setSignal();
          }
          const calls = { connection: 0, model: 0 };
          const runProbe = storageOnlyPolling(gateway, calls);
          await runProbe();
          await runProbe();
          assert.deepStrictEqual(calls, { connection: 0, model: 0 });
          assert.strictEqual(stopCalls, status === 'cancelled' ? 1 : 0);
          assert.strictEqual(deliveries, alreadyConfirmed ? 0 : 1);
          const expectedType = STATE_EVENT_TYPES[status] || 'task.cancelled';
          assert.deepStrictEqual(events.events.map(event => event.type), [expectedType]);
          if (interactionRequestId) assert.strictEqual(events.events[0].interactionRequestId, interactionRequestId);
          const historyStatus = { done: 'completed', error: 'failed', queue_timeout: 'failed', review_rejected: 'cancelled' }[status] || status;
          assert.strictEqual(history.getTask(taskId).status, historyStatus);
          assert.deepStrictEqual(history.getTask(taskId).result, result);
          if (queue.has(taskId)) {
            assert.strictEqual(queue.get(taskId).statePersistencePending, undefined);
            assert.strictEqual(queue.get(taskId).cancelPersistencePending, undefined);
          }
        } finally {
          service.close();
          history.shutdown();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }
});

asyncTest('concurrent cancellations share one confirmed event and generation stop', async () => {
  const dir = makeTempDir();
  const history = newHistoryStore(path.join(dir, 'history.json'));
  const queue = new Map();
  const service = newQueueService(path.join(dir, 'queue.json'), { taskHistoryStore: history });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let finishDelivery;
  let deliveries = 0;
  let stopCalls = 0;
  const task = orchestrator.createQueuedTask({ task: 'cancel once', chatId: 'fixture-chat' });
  task.status = 'executing';
  task.submittedToTrae = true;
  service.persist(queue);
  gateway.driver = { stopGeneration: async () => { stopCalls++; return { success: true }; } };
  gateway.completionSignal = new CompletionSignal({
    getTaskEventStore: () => events,
    notifyOpenClaw: () => { deliveries++; return new Promise(resolve => { finishDelivery = resolve; }); }
  });
  try {
    const first = dispatchCancellation(gateway, task.taskId);
    const second = dispatchCancellation(gateway, task.taskId);
    assert.strictEqual(task.cancelPersistencePending.previousStatus, 'executing');
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(stopCalls, 1);
    finishDelivery();
    const responses = await Promise.all([first, second]);
    assert.deepStrictEqual(responses.map(response => response.statusCode), [200, 200]);
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(deliveries, 1);
    assert.strictEqual(task.cancelPersistencePending, undefined);
  } finally {
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('late delegate rejection retains the submitted identity when error persistence fails', async () => {
  const dir = makeTempDir();
  const history = newHistoryStore(path.join(dir, 'history.json'));
  const queue = new Map();
  let failWrites = false;
  const service = newQueueService(path.join(dir, 'queue.json'), {
    taskHistoryStore: history,
    onWritePhase(phase) {
      if (failWrites && phase === 'temp_opened') throw Object.assign(new Error('injected error persist EIO'), { code: 'EIO' });
    }
  });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let rejectDelegate;
  let modelCalls = 0;
  gateway.mockBridge = true;
  gateway._ensureConnection = async () => {};
  gateway._assertProjectWorkspace = async () => {};
  gateway._captureTaskSoloChat = async () => {};
  gateway._retryBackgroundTaskAfterError = async () => false;
  gateway._setTimeout = callback => setImmediate(callback);
  gateway._clearTimeout = clearImmediate;
  gateway.driver = {
    checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: true }),
    delegate: () => { modelCalls++; return new Promise((_resolve, reject) => { rejectDelegate = reject; }); }
  };
  try {
    const request = Readable.from([JSON.stringify({ task: 'original late delegate failure' })]);
    const response = await gateway._handleDelegateAsync(request, {});
    assert.strictEqual(response.status, 'executing');
    const task = queue.get(response.taskId);
    failWrites = true;
    rejectDelegate(new Error('captured late model error'));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(task.error, 'captured late model error');
    assert.deepStrictEqual(task.statePersistencePending, { previousStatus: 'executing', status: 'error' });
    assert.strictEqual(service.taskLocks.has(task.taskId), false);
    assert.strictEqual(events.events.length, 0);
    assert.strictEqual(modelCalls, 1);
    failWrites = false;
    const calls = { connection: 0, model: 0 };
    await storageOnlyPolling(gateway, calls)();
    assert.deepStrictEqual(calls, { connection: 0, model: 0 });
    assert.strictEqual(task.statePersistencePending, undefined);
    assert.strictEqual(history.getTask(task.taskId).status, 'failed');
    assert.deepStrictEqual(events.events.map(event => event.type), ['task.error']);
    assert.strictEqual(modelCalls, 1);
  } finally {
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy active and terminal fingerprints remain replayable after an upgrade and restart', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'queue.json');
  const history = newHistoryStore(path.join(dir, 'history.json'));
  let service = newQueueService(queuePath, { taskHistoryStore: history });
  const request = { task: 'original legacy work', idempotencyKey: 'legacy-upgrade-key' };
  try {
    let queue = new Map();
    let orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = orchestrator.createQueuedTask(request);
    task.idempotencyFingerprint = orchestrator.fingerprintTaskRequest(request, 1);
    delete task.idempotencyFingerprintVersion;
    assert.strictEqual(service.persist(queue), true);
    service.close();

    queue = new Map();
    service = newQueueService(queuePath, { taskHistoryStore: history });
    orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    assert.strictEqual(service.restore(queue), 1);
    assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-upgrade-key', request).statusCode, 202);
    assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-upgrade-key', {
      ...request, task: 'different work'
    }).statusCode, 409);
    const restoredTask = queue.get(task.taskId);
    restoredTask.status = 'done';
    restoredTask.result = { text: 'original legacy result', stable: true };
    assert.strictEqual(orchestrator.recordTerminalTask(restoredTask), true);
    service.close();

    queue = new Map();
    service = newQueueService(queuePath, { taskHistoryStore: history });
    orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    assert.strictEqual(service.restore(queue), 0);
    assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-upgrade-key', request).statusCode, 200);
    assert.deepStrictEqual(orchestrator.resolveIdempotentTask('legacy-upgrade-key', request).result, {
      text: 'original legacy result', stable: true
    });
    assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-upgrade-key', {
      ...request, task: 'different terminal work'
    }).statusCode, 409);
  } finally {
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('new fingerprint semantics remain strict for durable terminal replays after restart', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'queue.json');
  const history = newHistoryStore(path.join(dir, 'history.json'));
  let service = newQueueService(queuePath, { taskHistoryStore: history });
  const request = {
    task: 'work with explicit queue parameters',
    idempotencyKey: 'new-fingerprint-key',
    maxQueueWaitMs: 3000,
    modelProbeIntervalMs: 15000
  };
  try {
    let queue = new Map();
    let orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    const task = orchestrator.createQueuedTask(request);
    task.status = 'done';
    assert.strictEqual(orchestrator.recordTerminalTask(task), true);
    service.close();

    queue = new Map();
    service = newQueueService(queuePath, { taskHistoryStore: history });
    orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
    assert.strictEqual(service.restore(queue), 0);
    assert.strictEqual(service.getTerminalReplay('new-fingerprint-key').fingerprintVersion, 2);
    assert.strictEqual(orchestrator.resolveIdempotentTask('new-fingerprint-key', request).statusCode, 200);
    assert.strictEqual(orchestrator.resolveIdempotentTask('new-fingerprint-key', {
      ...request, maxQueueWaitMs: 9000
    }).statusCode, 409);
    assert.strictEqual(orchestrator.resolveIdempotentTask('new-fingerprint-key', {
      ...request, modelProbeIntervalMs: 30000
    }).statusCode, 409);
  } finally {
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal idempotency replay expires at the configured TTL after restart', () => {
  const dir = makeTempDir();
  const queuePath = path.join(dir, 'active-queue.json');
  const historyPath = path.join(dir, 'history.json');
  const request = {
    task: 'work that may be deliberately repeated later',
    idempotencyKey: 'expiring-terminal-key'
  };
  let now = 1000;
  try {
    const history = newHistoryStore(historyPath);
    const queue = new Map();
    const service = newQueueService(queuePath, {
      taskHistoryStore: history,
      terminalReplayTtlMs: 100,
      now: () => now
    });
    const orchestrator = newOrchestrator({
      taskHistoryStore: history,
      taskQueueService: service,
      taskQueue: queue,
      now: () => now
    });
    const task = orchestrator.createQueuedTask(request, { queued: true });
    task.status = 'done';
    task.result = { text: 'expired answer', stable: true };
    assert.strictEqual(orchestrator.recordTerminalTask(task), true);
    service.close();

    now = 1100;
    const restoredQueue = new Map();
    const restoredService = newQueueService(queuePath, {
      taskHistoryStore: history,
      terminalReplayTtlMs: 100,
      now: () => now
    });
    restoredService.restore(restoredQueue);
    const restoredOrchestrator = newOrchestrator({
      taskHistoryStore: history,
      taskQueueService: restoredService,
      taskQueue: restoredQueue,
      now: () => now
    });

    assert.strictEqual(
      restoredOrchestrator.resolveIdempotentTask('expiring-terminal-key', request),
      null
    );
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

async function cancellationCrashScenario(retryMode) {
  const dir = makeTempDir();
  const restartedDir = makeTempDir();
  const history = newHistoryStore(path.join(dir, 'history.json'));
  const queue = new Map();
  const service = newQueueService(path.join(dir, 'queue.json'), { taskHistoryStore: history });
  const orchestrator = newOrchestrator({ taskHistoryStore: history, taskQueueService: service, taskQueue: queue });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const gateway = lifecycleGateway({ history, queue, service, orchestrator, events });
  let releaseStop;
  let originalStopCalls = 0;
  let cancellation;
  let restartedHistory;
  let restartedService;
  gateway.driver = { stopGeneration: () => {
    originalStopCalls++;
    return new Promise(resolve => { releaseStop = () => resolve({ success: true }); });
  } };
  try {
    const task = orchestrator.createQueuedTask({ task: 'Stop the original submitted work', idempotencyKey: 'crashed-cancel' });
    task.status = 'executing';
    task.submittedToTrae = true;
    task.soloChat = retryMode === 'missing-binding'
      ? { titleIncludes: 'Identical title', index: 0 } : { sessionId: 'original-crashed-session' };
    service.syncHistoryMirror(task);
    assert.strictEqual(history._persistNow(), true);
    cancellation = dispatchCancellation(gateway, task.taskId);
    assert.strictEqual(originalStopCalls, 1);
    assert.strictEqual(events.events.length, 1, 'the cancellation event is durable while native stop is unresolved');
    for (const file of ['queue.json', 'history.json', 'events.json']) {
      fs.copyFileSync(path.join(dir, file), path.join(restartedDir, file));
    }
    const crashedSnapshot = JSON.parse(fs.readFileSync(path.join(restartedDir, 'queue.json'), 'utf8'));
    assert.strictEqual(crashedSnapshot.tasks[0].cancelPersistencePending.previousStatus, 'executing');
    assert.strictEqual(crashedSnapshot.tasks[0].stopResult, undefined);

    // Boot solely from the bytes present at the crash boundary. The old
    // in-flight callback cannot write into this restarted store.
    restartedHistory = newHistoryStore(path.join(restartedDir, 'history.json'));
    const restartedEvents = new TaskEventStore({ persistencePath: path.join(restartedDir, 'events.json') });
    const restartedQueue = new Map();
    restartedService = newQueueService(path.join(restartedDir, 'queue.json'), {
      taskHistoryStore: restartedHistory,
      isTaskFinalizationConfirmed: stateEventProof(restartedEvents),
      isCancellationConfirmed: taskId => restartedEvents.events.some(event => (
        event.taskId === taskId && event.type === 'task.cancelled' && event.terminal
      ))
    });
    if (retryMode === 'dual-pending') {
      const snapshot = restartedService.taskStore.load();
      snapshot.tasks[0].statePersistencePending = { previousStatus: 'executing', status: 'cancelled' };
      assert.strictEqual(restartedService.taskStore.writeTasks(snapshot.tasks), true);
    }
    assert.strictEqual(restartedService.restore(restartedQueue), 1, 'a cancellation event alone does not prove native stop');
    const restored = restartedQueue.get(task.taskId);
    assert.strictEqual(restored.submittedToTrae, true);
    assert.strictEqual(restored.cancelPersistencePending.previousStatus, 'executing');
    const restartedOrchestrator = newOrchestrator({ taskHistoryStore: restartedHistory, taskQueueService: restartedService, taskQueue: restartedQueue });
    const restartedGateway = lifecycleGateway({ history: restartedHistory, queue: restartedQueue,
      service: restartedService, orchestrator: restartedOrchestrator, events: restartedEvents });
    let reconnects = 0;
    let stops = 0;
    let sends = 0;
    let lockHeld = false;
    let activeSession = retryMode === 'foreign-session' ? 'different-native-session'
      : retryMode === 'missing-active' ? null : 'original-crashed-session';
    const withUiLock = restartedGateway._withUiActionLock.bind(restartedGateway);
    restartedGateway._withUiActionLock = callback => withUiLock(async () => {
      lockHeld = true;
      try { return await callback(); } finally { lockHeld = false; }
    });
    restartedGateway._ensureConnection = async () => {
      reconnects++;
      restartedGateway.driver = {
        getActiveSoloChat: async () => {
          assert.strictEqual(lockHeld, true);
          return { active: activeSession ? { sessionId: activeSession, title: 'Identical title', index: 0 } : null };
        },
        stopGeneration: async () => { assert.strictEqual(lockHeld, true); stops++; return { success: true }; },
        sendMessage: async () => { sends++; }
      };
    };
    let poll;
    restartedGateway._setInterval = callback => { poll = callback; return { unref() {} }; };
    restartedGateway._ensureBackgroundPolling();
    await poll();
    assert.deepStrictEqual({ reconnects, stops, sends }, { reconnects: 0, stops: 0, sends: 0 }, 'polling cannot stop an unverified native conversation');
    if (['foreign-session', 'missing-active', 'missing-binding'].includes(retryMode)) {
      const rejected = await dispatchCancellation(restartedGateway, task.taskId);
      assert.strictEqual(rejected.statusCode, 409);
      assert.strictEqual(rejected.body.code, 'task_cancellation_conflict');
      assert.strictEqual(restored.cancelPersistencePending.previousStatus, 'executing');
      assert.strictEqual(restored.stopResult, undefined, 'a context mismatch cannot confirm native stop');
      assert.strictEqual(stops, 0);
      assert.strictEqual(sends, 0);
      assert.strictEqual(restartedService.taskStore.load().tasks[0].taskId, task.taskId);
      if (retryMode === 'missing-binding') return;
      activeSession = 'original-crashed-session';
    }
    const response = await dispatchCancellation(restartedGateway, task.taskId);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.taskId, task.taskId);
    assert.deepStrictEqual(response.body.stopResult, { success: true });
    assert.strictEqual(restored.status, 'cancelled');
    assert.deepStrictEqual(restored.stopResult, { success: true });
    assert.strictEqual(restored.cancelPersistencePending, undefined);
    assert.deepStrictEqual({ reconnects, stops, sends }, { reconnects: 1, stops: 1, sends: 0 });
    assert.strictEqual(restartedEvents.events.length, 1, 'retry must reuse the durable cancellation event');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(restartedDir, 'queue.json'), 'utf8')).tasks, []);
    assert.strictEqual(restartedHistory.getTask(task.taskId).status, 'cancelled');
  } finally {
    if (releaseStop) releaseStop();
    if (cancellation) await cancellation;
    restartedService?.close();
    restartedHistory?.shutdown();
    service.close();
    history.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(restartedDir, { recursive: true, force: true });
  }
}

for (const retryMode of ['request', 'dual-pending', 'foreign-session', 'missing-active', 'missing-binding']) {
  asyncTest(`a crash during native cancellation retains the original task for ${retryMode} recovery`, () => cancellationCrashScenario(retryMode));
}

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
})();
