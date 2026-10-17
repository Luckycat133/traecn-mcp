'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Gateway } = require('./gateway');
const { MockDriver } = require('../cdp/mock-driver');
const { TaskQueueService } = require('./task-queue-service');
const { TaskOrchestrator } = require('./task-orchestrator');
const { CompletionSignal } = require('./completion-signal');
const { TaskHistoryStore } = require('../shared/task-history');
const { TaskEventStore } = require('../shared/task-event-store');
const { createRunner } = require('../shared/test-runner');
const { Readable } = require('stream');
const { errorToHttpStatus } = require('./error-mapping');

const r = createRunner('gateway-batch-lifecycle.test.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const terminal = status => ['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected'].includes(status);

function fixture({ count = 1, strategy = 'sequential', maxConcurrency = 1, result = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-batch-lifecycle-'));
  const history = new TaskHistoryStore({ persistencePath: path.join(dir, 'history.json') });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const queue = new Map();
  const service = new TaskQueueService({ persistencePath: path.join(dir, 'queue.json'), taskHistoryStore: history, isTerminalStatus: terminal });
  const driver = new MockDriver();
  const calls = { collect: 0, delegate: 0, stop: 0, newChat: 0 };
  let interval;
  const tasks = Array.from({ length: count }, (_, index) => ({ taskId: `batch-fixture_${index}`,
    task: `Complete bounded offline fixture item ${index}`, priority: index + 1, status: 'pending', result: null, error: null }));
  const batch = { batchId: 'batch-fixture', tasks, strategy, maxConcurrency, status: 'running', createdAt: Date.now(),
    completedCount: 0, failedCount: 0, totalCount: count, results: [], onComplete: null };
  const gateway = Object.assign(Object.create(Gateway.prototype), {
    taskQueue: queue, taskHistoryStore: history, taskQueueService: service, taskLocks: service.taskLocks,
    taskEventStore: events, completionSignal: new CompletionSignal({ getTaskEventStore: () => events }),
    batchTasks: new Map([[batch.batchId, batch]]), sessions: new Map(), wsHandler: null,
    driver, mockBridge: true, activeTimers: new Set(), uiActionChain: Promise.resolve(),
    _ensureConnection: async () => {}, _assertProjectWorkspace: async () => {}, _ensureRequestedWorkspace: async () => {},
    _captureTaskSoloChat: async () => {},
    _setInterval: callback => { interval = callback; return { unref() {} }; }, _clearInterval: () => {},
    _json: (_req, res, data, status = 200) => Object.assign(res, { status, data })
  });
  gateway.taskOrchestrator = new TaskOrchestrator({ taskHistoryStore: history, taskQueue: queue, taskQueueService: service,
    syncTaskHistoryMirror: task => gateway._syncTaskHistoryMirror(task), isTerminalStatus: terminal });
  const delegate = driver.delegate.bind(driver);
  driver.delegate = async (...args) => { calls.delegate++; return delegate(...args); };
  driver.newChat = async () => { calls.newChat++; };
  driver.collectResponse = async () => { calls.collect++; return result || { text: 'Offline fixture final report. Completed successfully. All tests passed. '.repeat(5), stable: true }; };
  driver.checkForApprovalDialog = async () => result?.needsApproval ? result : { needsApproval: false };
  driver.stopGeneration = async () => { calls.stop++; return { success: true, method: 'offline-fixture-stop' }; };
  return { dir, history, events, queue, service, gateway, driver, tasks, batch, calls,
    poll: () => { assert.ok(interval, 'canonical background polling must be armed'); return interval(); },
    snapshot() { const response = {}; gateway._handleBatchStatus({}, response, batch.batchId); return response; },
    close() { gateway._stopBackgroundPolling(); service.close(); history.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

(async () => {
  for (const [name, result, expected] of [
    ['approval', { text: 'Partial fixture output', stable: false, needsApproval: true, dialogType: 'command',
      command: 'node fixture.test.js', question: 'Run this fixture?', options: [{ label: 'Allow' }, { label: 'Skip' }] }, 'approval_required'],
    ['interrupted', { text: 'Interrupted partial fixture output', stable: false, interrupted: true, error: 'generation interrupted' }, 'error'],
    ['timed-out partial', { text: 'Timed-out partial fixture output', stable: false, timedOut: true }, 'error']
  ]) {
    await r.asyncTest(`batch ${name} uses the canonical lifecycle and preserves its result`, async () => {
      const f = fixture({ result });
      try {
        f.tasks[0].status = 'executing';
        await f.gateway._executeSingleBatchTask(f.batch.batchId, f.tasks[0].taskId);
        assert.notStrictEqual(f.tasks[0].status, 'done', 'accepting a batch item cannot report model success');
        assert.ok(f.tasks[0].gatewayTaskId, 'the existing batch identity must map to a canonical task');
        const owned = f.queue.get(f.tasks[0].gatewayTaskId);
        assert.ok(owned);
        if (result.timedOut) owned.attempts = 3;
        await f.poll();
        const snapshot = f.snapshot();
        assert.strictEqual(snapshot.status, 200);
        assert.strictEqual(snapshot.data.tasks[0].taskId, 'batch-fixture_0');
        assert.strictEqual(snapshot.data.tasks[0].gatewayTaskId, owned.taskId);
        assert.strictEqual(snapshot.data.tasks[0].status, expected);
        assert.deepStrictEqual(snapshot.data.tasks[0].result, result);
        assert.strictEqual(snapshot.data.completedCount, 0);
        assert.strictEqual(snapshot.data.failedCount, expected === 'error' ? 1 : 0);
        assert.strictEqual(snapshot.data.status, expected === 'error' ? 'completed' : 'running');
        if (expected === 'approval_required') {
          assert.strictEqual(snapshot.data.tasks[0].interactionRequestId, owned.interactionRequestId);
          assert.ok(owned.interactionRequestId);
        }
        assert.strictEqual(f.calls.delegate, 0, 'batch must not bypass canonical send/collect ownership');
        assert.strictEqual(f.calls.collect, 1);
        assert.strictEqual(f.events.events.length, 1);
      } finally { f.close(); }
    });
  }

  await r.asyncTest('batch cancel stops the owned generation and ignores its late result', async () => {
    const f = fixture();
    let entered, release;
    const collecting = new Promise(resolve => { entered = resolve; });
    const response = new Promise(resolve => { release = resolve; });
    let running;
    f.driver.collectResponse = async () => { f.calls.collect++; entered(); return response; };
    try {
      f.tasks[0].status = 'executing';
      const execution = f.gateway._executeSingleBatchTask(f.batch.batchId, f.tasks[0].taskId);
      running = f.tasks[0].gatewayTaskId ? f.poll() : execution;
      await collecting;
      const cancelled = {};
      await f.gateway._handleBatchCancel({}, cancelled, f.batch.batchId);
      release({ text: 'Late offline fixture result', stable: true });
      await running;
      await execution;
      assert.strictEqual(cancelled.status, 200);
      assert.strictEqual(cancelled.data.status, 'cancelled');
      assert.strictEqual(f.tasks[0].status, 'cancelled');
      assert.strictEqual(f.calls.stop, 1);
      assert.strictEqual(f.batch.completedCount, 0);
      assert.strictEqual(f.gateway.batchTasks.has(f.batch.batchId), false);
      const owned = f.queue.get(f.tasks[0].gatewayTaskId);
      assert.strictEqual(owned.status, 'cancelled');
      assert.strictEqual(f.events.events.filter(event => event.taskId === owned.taskId && event.type === 'task.cancelled').length, 1);
    } finally {
      release({ text: 'Released fixture result', stable: true });
      if (running) await running;
      f.close();
    }
  });

  await r.asyncTest('parallel batch shares the existing gateway UI lock', async () => {
    const f = fixture({ count: 2, strategy: 'parallel', maxConcurrency: 2 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const normalAction = f.gateway._withUiActionLock(async () => gate);
    let polling;
    try {
      await tick();
      await f.gateway._executeBatchParallel(f.batch.batchId);
      if (f.tasks.some(task => task.gatewayTaskId)) polling = f.poll();
      await tick();
      assert.strictEqual(f.calls.delegate + f.calls.collect, 0, 'batch cannot enter a driver while another UI action owns the lock');
      release();
      await normalAction;
      await polling;
      assert.strictEqual(f.calls.collect, 2);
      assert.strictEqual(f.calls.delegate, 0);
      assert.strictEqual(f.batch.completedCount, 2);
      assert.strictEqual(f.gateway.uiActionInFlight, 0);
      assert.strictEqual(f.service.taskLocks.size, 0);
    } finally { release(); await normalAction; if (polling) await polling; await tick(); f.close(); }
  });

  await r.asyncTest('sequential batch keeps approval in its slot and creates the next identity once', async () => {
    const result = { text: 'Partial approval result', needsApproval: true, dialogType: 'command', command: 'node fixture.test.js' };
    const f = fixture({ count: 2, result });
    try {
      f.gateway._startBatchExecution(f.batch.batchId);
      const firstId = f.tasks[0].gatewayTaskId;
      assert.ok(firstId);
      assert.strictEqual(f.tasks[1].gatewayTaskId, undefined);
      await f.poll();
      for (let i = 0; i < 3; i++) f.snapshot();
      assert.strictEqual(f.tasks[0].status, 'approval_required');
      assert.strictEqual(f.tasks[1].status, 'pending');
      assert.strictEqual(f.queue.size, 1);
      assert.strictEqual(f.calls.collect, 1);
      const owned = f.queue.get(firstId);
      await f.gateway._finalizeBackgroundTask(firstId, owned, 'done', { result: { text: 'Confirmed first completion', stable: true } });
      const secondId = f.tasks[1].gatewayTaskId;
      assert.ok(secondId);
      assert.notStrictEqual(secondId, firstId);
      f.gateway._startBatchExecution(f.batch.batchId);
      f.snapshot();
      assert.strictEqual(f.queue.size, 2);
      assert.strictEqual(f.tasks[1].gatewayTaskId, secondId);
      f.driver.collectResponse = async () => { f.calls.collect++; return { text: 'Offline final report. All tests passed. '.repeat(6), stable: true }; };
      await f.poll();
      assert.strictEqual(f.batch.status, 'completed');
      assert.strictEqual(f.batch.completedCount, 2);
      assert.strictEqual(f.calls.delegate, 0);
      assert.strictEqual(f.calls.collect, 2);
    } finally { f.close(); }
  });

  await r.asyncTest('priority batching preserves legacy item IDs and the concurrency cap', async () => {
    const f = fixture({ count: 3, strategy: 'priority', maxConcurrency: 2 });
    try {
      f.gateway._startBatchExecution(f.batch.batchId);
      assert.strictEqual(f.tasks[0].gatewayTaskId, undefined);
      assert.ok(f.tasks[1].gatewayTaskId);
      assert.ok(f.tasks[2].gatewayTaskId);
      assert.strictEqual(f.queue.size, 2);
      assert.deepStrictEqual([...f.queue.values()].map(task => task.task), [f.tasks[2].task, f.tasks[1].task]);
      await f.poll();
      assert.strictEqual(f.queue.size, 3);
      assert.deepStrictEqual(f.driver.sentMessages, [f.tasks[2].task, f.tasks[1].task, f.tasks[0].task]);
      assert.deepStrictEqual(f.snapshot().data.tasks.map(task => task.taskId), ['batch-fixture_0', 'batch-fixture_1', 'batch-fixture_2']);
      assert.strictEqual(f.batch.completedCount, 3);
      assert.strictEqual(f.batch.status, 'completed');
    } finally { f.close(); }
  });

  for (const store of ['task', 'event']) {
    await r.asyncTest(`batch completion waits for confirmed ${store} persistence and retries only storage`, async () => {
      const f = fixture();
      try {
        f.gateway._startBatchExecution(f.batch.batchId);
        const owned = f.queue.get(f.tasks[0].gatewayTaskId);
        const target = store === 'task' ? f.service.taskStore : f.events;
        target.onWritePhase = phase => { if (phase === 'temp_opened') throw Object.assign(new Error('isolated storage fault'), { code: 'EIO' }); };
        const result = { text: 'Preserved original completion candidate', stable: true };
        await assert.rejects(f.gateway._finalizeBackgroundTask(owned.taskId, owned, 'done', { result }), error => {
          assert.strictEqual(errorToHttpStatus(error), 503);
          return error.code === 'TASK_STORE_UNAVAILABLE';
        });
        const pending = f.snapshot().data;
        assert.strictEqual(pending.status, 'running');
        assert.strictEqual(pending.completedCount, 0);
        assert.strictEqual(pending.tasks[0].status, 'executing');
        assert.strictEqual(pending.tasks[0].statePersistencePending, true);
        assert.deepStrictEqual(pending.tasks[0].result, result);
        assert.strictEqual(pending.tasks[0].interactionRequestId, undefined);
        assert.strictEqual(f.events.events.length, 0);
        target.onWritePhase = null;
        await f.poll();
        assert.strictEqual(f.batch.status, 'completed');
        assert.strictEqual(f.batch.completedCount, 1);
        assert.strictEqual(f.queue.size, 1);
        assert.strictEqual(f.tasks[0].gatewayTaskId, owned.taskId);
        assert.deepStrictEqual(f.tasks[0].result, result);
        assert.strictEqual(f.events.events.length, 1);
        assert.deepStrictEqual(f.calls, { collect: 0, delegate: 0, stop: 0, newChat: 0 });
      } finally { f.close(); }
    });
  }

  await r.asyncTest('failed durable batch cancellation retains the same group and identities for retry', async () => {
    const f = fixture({ count: 2 });
    try {
      f.gateway._startBatchExecution(f.batch.batchId);
      const taskId = f.tasks[0].gatewayTaskId;
      f.service.taskStore.onWritePhase = phase => { if (phase === 'temp_opened') throw Object.assign(new Error('isolated cancel fault'), { code: 'ENOSPC' }); };
      const failed = {};
      await assert.rejects(f.gateway._handleBatchCancel({}, failed, f.batch.batchId), error => errorToHttpStatus(error) === 503);
      assert.strictEqual(failed.data, undefined, 'failed persistence cannot return cancellation success');
      assert.strictEqual(f.gateway.batchTasks.get(f.batch.batchId), f.batch);
      assert.strictEqual(f.tasks[0].gatewayTaskId, taskId);
      assert.strictEqual(f.events.events.length, 0);
      f.gateway._startBatchExecution(f.batch.batchId);
      assert.strictEqual(f.tasks[1].gatewayTaskId, undefined);
      assert.strictEqual(f.calls.stop, 0);
      f.service.taskStore.onWritePhase = null;
      const retried = {};
      await f.gateway._handleBatchCancel({}, retried, f.batch.batchId);
      assert.strictEqual(retried.status, 200);
      assert.strictEqual(retried.data.status, 'cancelled');
      assert.strictEqual(f.gateway.batchTasks.has(f.batch.batchId), false);
      assert.strictEqual(f.queue.size, 1);
      assert.strictEqual(f.queue.get(taskId).status, 'cancelled');
      assert.strictEqual(f.tasks[1].gatewayTaskId, undefined);
      assert.strictEqual(f.tasks[1].status, 'cancelled');
      assert.strictEqual(f.events.events.length, 1);
      assert.strictEqual(f.calls.delegate + f.calls.collect + f.calls.stop, 0);
    } finally { f.close(); }
  });

  await r.asyncTest('concurrent batch cancellations share one owned stop and event', async () => {
    const f = fixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const emit = f.gateway._emitTaskNotification.bind(f.gateway);
    let first, second;
    try {
      f.gateway._startBatchExecution(f.batch.batchId);
      const owned = f.queue.get(f.tasks[0].gatewayTaskId);
      owned.status = 'executing';
      owned.submittedToTrae = true;
      f.gateway._emitTaskNotification = async (...args) => { const result = await emit(...args); await gate; return result; };
      const a = {}, b = {};
      first = f.gateway._handleBatchCancel({}, a, f.batch.batchId);
      await tick();
      second = f.gateway._handleBatchCancel({}, b, f.batch.batchId);
      release();
      await Promise.all([first, second]);
      assert.strictEqual(a.status, 200);
      assert.strictEqual(b.status, 200);
      assert.strictEqual(f.calls.stop, 1);
      assert.strictEqual(f.events.events.length, 1);
      assert.strictEqual(f.batch.completedCount, 0);
    } finally { release(); await Promise.all([first, second]); f.close(); }
  });

  await r.asyncTest('batch status uses canonical terminal history after active cleanup', async () => {
    const f = fixture();
    let reloaded;
    try {
      f.gateway._startBatchExecution(f.batch.batchId);
      await f.poll();
      const taskId = f.tasks[0].gatewayTaskId;
      const original = f.tasks[0].result;
      f.queue.clear();
      assert.strictEqual(f.service.persist(f.queue), true);
      f.history.shutdown();
      reloaded = new TaskHistoryStore({ persistencePath: path.join(f.dir, 'history.json') });
      f.gateway.taskHistoryStore = reloaded;
      const snapshot = f.snapshot();
      assert.strictEqual(snapshot.data.tasks[0].gatewayTaskId, taskId);
      assert.strictEqual(snapshot.data.tasks[0].status, 'done');
      assert.deepStrictEqual(snapshot.data.tasks[0].result, original);
      assert.strictEqual(snapshot.data.completedCount, 1);
      assert.strictEqual(f.queue.size, 0);
      const historyResponse = {};
      await f.gateway._handleTaskStatus({ url: `/api/task/${taskId}` }, historyResponse, taskId);
      assert.strictEqual(historyResponse.data.fromHistory, true);
      assert.strictEqual(historyResponse.data.status, 'done');
      assert.deepStrictEqual(historyResponse.data.result, original);
      assert.strictEqual(f.events.events.length, 1);
    } finally { if (reloaded) reloaded.shutdown(); f.close(); }
  });

  await r.asyncTest('batch aggregate completion callback fires once and hides task traces', async () => {
    const f = fixture({ count: 2 });
    const fetch = global.fetch;
    const notifications = [];
    try {
      global.fetch = async (url, options) => { notifications.push({ url, payload: JSON.parse(options.body) }); return { ok: true }; };
      f.batch.onComplete = 'https://offline-fixture.invalid/completed';
      f.driver.collectResponse = async () => ({ text: 'Offline final report. All tests passed. '.repeat(6), stable: true, traceText: 'private fixture trace' });
      f.gateway._startBatchExecution(f.batch.batchId);
      await f.poll();
      for (let i = 0; i < 3; i++) { f.snapshot(); f.gateway._checkBatchCompletion(f.batch.batchId); }
      await tick();
      assert.strictEqual(notifications.length, 1);
      assert.strictEqual(notifications[0].payload.status, 'completed');
      assert.strictEqual(notifications[0].payload.completedCount, 2);
      assert.strictEqual(notifications[0].payload.results.length, 2);
      assert.ok(notifications[0].payload.results.every(item => item.gatewayTaskId && !Object.hasOwn(item.result, 'traceText')));
      assert.strictEqual(f.events.events.length, 2);
    } finally { global.fetch = fetch; f.close(); }
  });

  await r.asyncTest('batch POST retains its compatibility response and lazily accepts canonical items', async () => {
    const f = fixture();
    try {
      f.gateway.batchTasks.clear();
      const req = Readable.from([JSON.stringify({ tasks: [{ task: 'Original first item' }, { task: 'Original second item' }], strategy: 'sequential', maxConcurrency: 1 })]);
      req.headers = { 'content-type': 'application/json' };
      const response = {};
      await f.gateway._handleBatchSubmit(req, response);
      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.data.status, 'running');
      assert.strictEqual(response.data.totalTasks, 2);
      assert.strictEqual(response.data.strategy, 'sequential');
      assert.strictEqual(response.data.maxConcurrency, 1);
      const batch = f.gateway.batchTasks.get(response.data.batchId);
      assert.strictEqual(batch.tasks[0].taskId, `${batch.batchId}_0`);
      assert.strictEqual(batch.tasks[1].taskId, `${batch.batchId}_1`);
      assert.ok(batch.tasks[0].gatewayTaskId);
      assert.strictEqual(batch.tasks[1].gatewayTaskId, undefined);
      assert.strictEqual(f.queue.size, 1);
      assert.strictEqual(f.history.tasks.size, 1);
      assert.strictEqual(f.calls.delegate + f.calls.collect, 0);
      const cancelled = {};
      await f.gateway._handleBatchCancel({}, cancelled, batch.batchId);
      assert.strictEqual(cancelled.status, 200);
    } finally { f.close(); }
  });

  await r.asyncTest('batch input rejects unusable concurrency instead of accepting a stalled group', async () => {
    const f = fixture();
    try {
      f.gateway.batchTasks.clear();
      for (const maxConcurrency of ['invalid', '2', null, {}, [], 2.5]) {
        const req = Readable.from([JSON.stringify({ tasks: [{ task: 'Bounded offline input validation' }], maxConcurrency })]);
        req.headers = { 'content-type': 'application/json' };
        const response = {};
        await f.gateway._handleBatchSubmit(req, response);
        assert.strictEqual(response.status, 400, `invalid concurrency ${JSON.stringify(maxConcurrency)} cannot be accepted`);
        assert.strictEqual(f.gateway.batchTasks.size, 0);
        assert.strictEqual(f.queue.size, 0);
      }
    } finally { f.close(); }
  });

  await r.asyncTest('priority zero is preserved and numeric concurrency still clamps to a usable slot', async () => {
    const f = fixture();
    try {
      f.gateway.batchTasks.clear();
      const req = Readable.from([JSON.stringify({ tasks: [{ task: 'Zero priority original item', priority: 0 }, { task: 'Higher priority original item', priority: 1 }],
        strategy: 'priority', maxConcurrency: 0 })]);
      req.headers = { 'content-type': 'application/json' };
      const response = {};
      await f.gateway._handleBatchSubmit(req, response);
      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.data.maxConcurrency, 1);
      const batch = f.gateway.batchTasks.get(response.data.batchId);
      assert.strictEqual(batch.tasks.find(task => task.taskId === `${batch.batchId}_0`).priority, 0);
      assert.strictEqual(f.queue.size, 1);
      assert.strictEqual([...f.queue.values()][0].task, 'Higher priority original item');
    } finally { f.close(); }
  });

  await r.asyncTest('confirmed completed failed and cancelled batch counts close over the original total', async () => {
    const f = fixture({ count: 2, strategy: 'parallel', maxConcurrency: 2 });
    try {
      f.gateway._startBatchExecution(f.batch.batchId);
      const cancelled = {};
      await f.gateway._handleTaskCancel({}, cancelled, f.tasks[0].gatewayTaskId);
      await f.poll();
      const snapshot = f.snapshot().data;
      assert.strictEqual(snapshot.status, 'completed');
      assert.strictEqual(snapshot.completedCount, 1);
      assert.strictEqual(snapshot.failedCount, 0);
      assert.strictEqual(snapshot.cancelledCount, 1);
      assert.strictEqual(snapshot.completedCount + snapshot.failedCount + snapshot.cancelledCount + snapshot.pendingCount + snapshot.executingCount, snapshot.totalCount);
      assert.strictEqual(f.calls.collect, 1);
      assert.strictEqual(f.events.events.length, 2);
    } finally { f.close(); }
  });

  await r.asyncTest('batch GET refreshes its projection without dispatching unscheduled work', async () => {
    const f = fixture({ count: 2, strategy: 'parallel', maxConcurrency: 2 });
    try {
      f.tasks[0].status = 'executing';
      const snapshot = f.snapshot().data;
      assert.strictEqual(snapshot.pendingCount, 1);
      assert.strictEqual(snapshot.executingCount, 1);
      assert.strictEqual(f.tasks[1].gatewayTaskId, undefined);
      assert.strictEqual(f.queue.size, 0);
      assert.strictEqual(f.history.tasks.size, 0);
    } finally { f.close(); }
  });

  for (const phase of ['temp_opened', 'primary_committed']) await r.asyncTest(`initial batch commit failure at ${phase} preserves its original identity for storage retry`, async () => {
    const f = fixture();
    try {
      f.service.taskStore.onWritePhase = current => { if (current === phase) throw Object.assign(new Error('isolated acceptance fault'), { code: 'EIO' }); };
      f.gateway._startBatchExecution(f.batch.batchId);
      await tick();
      assert.ok(f.tasks[0].gatewayTaskId, 'uncertain acceptance cannot lose the original persisted task identity');
      const taskId = f.tasks[0].gatewayTaskId;
      if (phase === 'primary_committed') {
        const disk = f.service.taskStore.load();
        assert.strictEqual(disk.tasks.length, 1);
        assert.strictEqual(taskId, disk.tasks[0].taskId);
        assert.strictEqual(disk.tasks[0].statePersistencePending.status, 'queued');
      }
      assert.strictEqual(f.queue.size, 1);
      assert.strictEqual(f.batch.failedCount, 0);
      assert.strictEqual(f.batch.status, 'running');
      assert.strictEqual(f.calls.delegate + f.calls.collect, 0);
      await f.poll();
      assert.deepStrictEqual(f.calls, { collect: 0, delegate: 0, stop: 0, newChat: 0 });
      assert.strictEqual(f.events.events.length, 0, 'queued acceptance has no completion event');
      f.service.taskStore.onWritePhase = null;
      await f.poll();
      assert.strictEqual(f.calls.collect, 0, 'the confirmation pass retries storage only');
      await f.poll();
      assert.strictEqual(f.batch.completedCount, 1);
      assert.strictEqual(f.queue.size, 1);
      assert.strictEqual(f.tasks[0].gatewayTaskId, taskId);
      assert.strictEqual(f.calls.collect, 1);
    } finally { f.close(); }
  });

  await r.asyncTest('a failed history mirror and uncertain queue commit recover the original task after restart', async () => {
    const f = fixture();
    let reloadedHistory, reloadedService;
    try {
      f.history.onWritePhase = phase => { if (phase === 'temp_opened') throw Object.assign(new Error('isolated history fault'), { code: 'EIO' }); };
      f.service.taskStore.onWritePhase = phase => { if (phase === 'primary_committed') throw Object.assign(new Error('isolated queue commit fault'), { code: 'EIO' }); };
      f.gateway._startBatchExecution(f.batch.batchId);
      await tick();
      const taskId = f.tasks[0].gatewayTaskId;
      assert.ok(taskId);
      assert.strictEqual(f.history._persistNow(), false);
      assert.strictEqual(f.history.getHealth().historyStoreWritable, false);
      assert.strictEqual(f.service.taskStore.load().tasks[0].taskId, taskId);
      assert.strictEqual(f.calls.collect, 0);
      f.service.close();
      f.history.shutdown();
      f.queue.clear();
      f.gateway.batchTasks.clear(); // Group recovery is outside the legacy contract.
      reloadedHistory = new TaskHistoryStore({ persistencePath: path.join(f.dir, 'history.json') });
      reloadedService = new TaskQueueService({ persistencePath: path.join(f.dir, 'queue.json'), taskHistoryStore: reloadedHistory, isTerminalStatus: terminal });
      assert.strictEqual(reloadedService.restore(f.queue), 1);
      assert.strictEqual(f.queue.get(taskId).statePersistencePending.status, 'queued');
      assert.strictEqual(reloadedHistory.getTask(taskId).status, 'queued');
      assert.strictEqual(reloadedHistory.tasks.size, 1);
      Object.assign(f.gateway, { taskHistoryStore: reloadedHistory, taskQueueService: reloadedService, taskLocks: reloadedService.taskLocks });
      Object.assign(f.gateway.taskOrchestrator, { taskHistoryStore: reloadedHistory, taskQueueService: reloadedService });
      reloadedService.taskStore.onWritePhase = phase => { if (phase === 'temp_opened') throw Object.assign(new Error('continued isolated fault'), { code: 'EIO' }); };
      await f.poll();
      assert.deepStrictEqual(f.calls, { collect: 0, delegate: 0, stop: 0, newChat: 0 });
      reloadedService.taskStore.onWritePhase = null;
      await f.poll();
      assert.strictEqual(f.calls.collect, 0);
      await f.poll();
      assert.strictEqual(f.calls.collect, 1);
      assert.strictEqual(f.queue.size, 1);
      assert.strictEqual(f.queue.get(taskId).status, 'done');
      assert.strictEqual(reloadedHistory.tasks.size, 1);
      assert.strictEqual(reloadedHistory.getTask(taskId).status, 'completed');
      assert.strictEqual(f.events.events.length, 1);
      assert.strictEqual(f.gateway.batchTasks.size, 0);
    } finally {
      if (reloadedService) reloadedService.close();
      if (reloadedHistory) reloadedHistory.shutdown();
      f.close();
    }
  });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  r.summary();
  if (r.failed) process.exitCode = 1;
});
