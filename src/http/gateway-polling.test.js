'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('../shared/test-runner');
const { Gateway } = require('./gateway');
const { TaskStore } = require('./task-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-polling-test-'));
const r = createRunner('gateway-polling.test.js');
let fixtureIndex = 0;

function fixture(count = 100) {
  const queue = new Map(Array.from({ length: count }, (_, index) => {
    const taskId = `isolated-${++fixtureIndex}-${index}`;
    return [taskId, { taskId, task: 'Complete this isolated queue task', status: 'queued', createdAt: Date.now() }];
  }));
  const store = new TaskStore({ persistencePath: path.join(root, `queue-${fixtureIndex}.json`) });
  let interval;
  let closed = false;
  const calls = { connects: 0, prepares: 0, checks: 0, persists: 0, arms: 0, finalizes: 0, retries: 0 };
  const locks = new Set();
  const gateway = Object.assign(Object.create(Gateway.prototype), {
    taskQueue: queue, taskLocks: locks, activeTimers: new Set(), batchTasks: new Map(),
    taskQueueService: {
      tryAcquire: id => { locks.add(id); return true; },
      release: id => locks.delete(id),
      clearLocks: () => locks.clear(),
      close: () => { closed = true; store.close(); }
    },
    taskHistoryStore: { shutdown: () => {} },
    driver: { checkQueueStatus: async () => { calls.checks++; return { running: true, queued: false }; } },
    _setInterval: callback => { calls.arms++; interval = callback; return { unref() {} }; },
    _clearInterval: () => {},
    _clearAllTimers: () => {},
    _ensureConnection: async () => { calls.connects++; },
    _prepareQueuedTask: async () => { calls.prepares++; },
    _updateQueuedTaskSnapshot: () => {},
    _syncTaskHistoryMirror: () => {},
    _persistActiveQueue: () => {
      assert.strictEqual(closed, false, 'poll must not write after its store was closed');
      calls.persists++;
      assert.strictEqual(store.persist(queue), true);
    },
    _finalizeBackgroundTask: async () => { calls.finalizes++; },
    _retryBackgroundTaskAfterError: async () => { calls.retries++; return true; }
  });
  return { gateway, calls, store, queue, poll: () => interval(), close: () => store.close() };
}

(async () => {
  await r.asyncTest('busy queued tasks yield to native I/O while retaining each durable snapshot', async () => {
    const f = fixture();
    try {
      f.gateway._ensureBackgroundPolling();
      let persistedAtPulse;
      const pulse = new Promise(resolve => setImmediate(() => { persistedAtPulse = f.calls.persists; resolve(); }));
      const polling = f.poll();
      await f.poll();
      await polling;
      await pulse;
      assert.ok(persistedAtPulse < 100, 'a native event-loop callback must run before the whole queue finishes');
      assert.strictEqual(f.calls.connects, 1, 'overlapping intervals must not enter the active poll');
      assert.strictEqual(f.calls.persists, 100, 'fairness must retain every existing per-task commit');
      assert.strictEqual(f.calls.checks, 100);
      assert.strictEqual(f.store.load().tasks.length, 100);
      assert.strictEqual(f.store.getHealth().durabilityDegraded, false);
      assert.strictEqual(f.gateway.isPolling, false);
      assert.strictEqual(f.gateway.taskLocks.size, 0);
    } finally { f.close(); }
  });

  await r.asyncTest('shutdown during a busy poll stops further work and cannot rearm its interval', async () => {
    const f = fixture();
    try {
      f.gateway._ensureBackgroundPolling();
      let closing;
      const pulse = new Promise(resolve => setImmediate(() => { closing = f.gateway.gracefulShutdown(); resolve(); }));
      await f.poll();
      await pulse;
      await closing;
      assert.ok(f.calls.checks < 100, 'shutdown must run before the queue loop exhausts every task');
      const committed = f.calls.persists;
      const connects = f.calls.connects;
      await f.poll();
      f.gateway._ensureBackgroundPolling();
      assert.strictEqual(f.calls.persists, committed);
      assert.strictEqual(f.calls.connects, connects);
      assert.strictEqual(f.calls.arms, 1);
      assert.strictEqual(f.gateway.pollingTimer, null);
      assert.strictEqual(f.gateway.isPolling, false);
      assert.strictEqual(f.store.load().tasks.length, 100, 'shutdown retains original queued identities');
      assert.strictEqual(f.calls.finalizes, 0);
    } finally { f.close(); }
  });

  await r.asyncTest('a connection await resolved after shutdown does not prepare or reconnect queued work', async () => {
    const f = fixture(1);
    let resume;
    f.gateway._ensureConnection = () => {
      f.calls.connects++;
      return new Promise(resolve => { resume = resolve; });
    };
    try {
      f.gateway._ensureBackgroundPolling();
      const polling = f.poll();
      await f.gateway.gracefulShutdown();
      resume();
      await polling;
      await f.poll();
      f.gateway._ensureBackgroundPolling();
      assert.strictEqual(f.calls.connects, 1);
      assert.strictEqual(f.calls.prepares, 0);
      assert.strictEqual(f.calls.checks, 0);
      assert.strictEqual(f.calls.arms, 1);
      assert.strictEqual(f.calls.persists, 1);
      assert.strictEqual(f.gateway.isPolling, false);
    } finally { f.close(); }
  });

  await r.asyncTest('an in-flight submitted collector rejection after shutdown cannot schedule recovery or terminal state', async () => {
    const f = fixture(1);
    const task = [...f.queue.values()][0];
    task.status = 'executing';
    task.submittedToTrae = true;
    let rejectCollect;
    let startedCollect;
    const collecting = new Promise(resolve => { startedCollect = resolve; });
    f.gateway._finalizePersistedResultIfComplete = async () => false;
    f.gateway._collectSubmittedBackgroundTask = () => {
      startedCollect();
      return new Promise((resolve, reject) => { rejectCollect = reject; });
    };
    try {
      f.gateway._ensureBackgroundPolling();
      const polling = f.poll();
      await collecting;
      await f.gateway.gracefulShutdown();
      rejectCollect(new Error('Own CDP closed during shutdown'));
      await polling;
      assert.strictEqual(f.calls.retries, 0);
      assert.strictEqual(f.calls.finalizes, 0);
      assert.strictEqual(f.gateway.taskLocks.size, 0);
      assert.strictEqual(f.gateway.isPolling, false);
      const persisted = f.store.load().tasks;
      assert.strictEqual(persisted[0].taskId, task.taskId);
      assert.strictEqual(persisted[0].submittedToTrae, true);
    } finally { f.close(); }
  });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  r.summary();
  if (r.failed) process.exitCode = 1;
  fs.rmSync(root, { recursive: true, force: true });
});
