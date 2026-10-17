'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Gateway } = require('./gateway');
const { TaskQueueService } = require('./task-queue-service');
const { TaskOrchestrator } = require('./task-orchestrator');
const { CompletionSignal } = require('./completion-signal');
const { handleTaskStatus } = require('./handlers/task-actions');
const { McpTaskAdapter } = require('../mcp/task-extension');
const { TaskHistoryStore } = require('../shared/task-history');
const { TaskEventStore } = require('../shared/task-event-store');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('gateway-workflow-history.test.js');
const terminal = status => ['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected'].includes(status);

function setup(dir, mirror, historyOptions = {}) {
  const history = new TaskHistoryStore({ ...historyOptions, persistencePath: path.join(dir, 'history.json') });
  const events = new TaskEventStore({ persistencePath: path.join(dir, 'events.json') });
  const queue = new Map();
  const service = new TaskQueueService({ persistencePath: path.join(dir, 'queue.json'), taskHistoryStore: history, isTerminalStatus: terminal,
    isTaskFinalizationConfirmed: (...args) => Gateway.prototype._hasConfirmedTaskStateEvent.call({ taskEventStore: events }, ...args) });
  const gateway = Object.assign(Object.create(Gateway.prototype), {
    taskQueue: queue, taskHistoryStore: history, taskQueueService: service, taskLocks: service.taskLocks,
    sessions: new Map(), wsHandler: null, taskEventStore: events,
    completionSignal: new CompletionSignal({ getTaskEventStore: () => events }),
    _ensureBackgroundPolling: () => {},
    _ensureConnection: async () => { throw new Error('History reads must not connect to a driver'); },
    _json: (_req, res, data, status = 200) => { Object.assign(res, { status, data }); }
  });
  if (mirror === 'recovery') gateway._syncTaskHistoryMirror = task => service.syncHistoryMirror(task);
  const orchestrator = new TaskOrchestrator({
    taskHistoryStore: history, taskQueue: queue, taskQueueService: service,
    syncTaskHistoryMirror: task => gateway._syncTaskHistoryMirror(task), isTerminalStatus: terminal
  });
  gateway.taskOrchestrator = orchestrator;
  let created = 0;
  const create = gateway._createQueuedTask.bind(gateway);
  gateway._createQueuedTask = (...args) => { created++; return create(...args); };
  const snapshot = async taskId => {
    const response = {};
    await handleTaskStatus({ url: `/api/task/${taskId}` }, response, gateway, taskId);
    return response;
  };
  return { history, events, queue, service, gateway, snapshot, created: () => created,
    close() { service.close(); history.shutdown(); } };
}

(async () => {
  for (const mirror of ['gateway', 'recovery']) {
    await r.asyncTest(`${mirror} history mirror restores original parent and child metadata through HTTP and MCP after terminal cleanup`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-workflow-history-'));
      let f = setup(dir, mirror);
      try {
        const parent = f.gateway._createQueuedTask({ task: 'Review the original result', reviewRequired: true,
          followupTasks: [{ task: 'Complete the selected followup', reviewRequired: false }] });
        parent.status = 'awaiting_review';
        parent.result = { text: 'Original parent result', stable: true };
        parent.metadata = { taskCustom: { retained: true } };
        f.history.getTask(parent.taskId).metadata.historyCustom = { retained: true };
        f.gateway._syncTaskHistoryMirror(parent);

        const approved = await f.gateway._continueReviewedTask(parent.taskId, parent, 'approve', 'selected original decision');
        const childId = approved.nextTaskId;
        const child = f.queue.get(childId);
        assert.ok(childId);
        assert.strictEqual(child.workflowParentTaskId, parent.taskId);
        assert.strictEqual(f.created(), 2);
        const duplicate = await f.gateway._continueReviewedTask(parent.taskId, parent, 'approve', 'selected original decision');
        assert.strictEqual(duplicate.status, 'done');
        assert.strictEqual(f.created(), 2, 'a repeated terminal review cannot create another child');
        await f.gateway._finalizeBackgroundTask(childId, child, 'done', { result: { text: 'Original child result', stable: true } });

        // Terminal cleanup removes both identities from the active store;
        // all subsequent reads must use the original durable history.
        f.queue.clear();
        assert.strictEqual(f.service.persist(f.queue), true);
        const eventsBefore = f.events.events.length;
        const parentId = parent.taskId;
        f.close();
        f = setup(dir, mirror);
        assert.strictEqual(f.service.restore(f.queue), 0);
        assert.strictEqual(f.queue.size, 0);
        const parentSnapshot = await f.snapshot(parentId);
        const childSnapshot = await f.snapshot(childId);
        assert.strictEqual(parentSnapshot.status, 200);
        assert.strictEqual(childSnapshot.status, 200);
        assert.strictEqual(parentSnapshot.data.fromHistory, true);
        assert.strictEqual(childSnapshot.data.fromHistory, true);
        assert.strictEqual(parentSnapshot.data.status, 'done');
        assert.strictEqual(childSnapshot.data.status, 'done');
        assert.strictEqual(parentSnapshot.data.metadata.nextTaskId, childId);
        assert.strictEqual(childSnapshot.data.metadata.workflowParentTaskId, parentId);
        assert.deepStrictEqual(parentSnapshot.data.metadata.historyCustom, { retained: true });
        assert.deepStrictEqual(parentSnapshot.data.metadata.taskCustom, { retained: true });

        const adapter = new McpTaskAdapter({ client: { getTaskStatus: f.snapshot } });
        const modernParent = await adapter.get(parentId);
        const modernChild = await adapter.get(childId);
        assert.strictEqual(modernParent.status, 'completed');
        assert.strictEqual(modernChild.status, 'completed');
        assert.strictEqual(modernParent.metadata.nextTaskId, childId);
        assert.strictEqual(modernChild.metadata.workflowParentTaskId, parentId);
        assert.strictEqual(f.created(), 0);
        assert.strictEqual(f.queue.size, 0);
        assert.strictEqual(f.events.events.length, eventsBefore, 'history reads cannot create another completion event');
      } finally {
        f.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const boundary of ['unflushed history', 'trimmed history and events', 'legacy child without completion proof']) {
    await r.asyncTest(`workflow child resumes once after restart with ${boundary}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-workflow-crash-'));
      let f = setup(dir, 'gateway', { persistDebounceMs: 60000 });
      try {
        const parent = f.gateway._createQueuedTask({ task: 'Review the original parent', reviewRequired: true,
          followupTasks: [{ task: 'Run the original followup', reviewRequired: false }] });
        parent.status = 'awaiting_review';
        parent.result = { text: 'The original reviewed result', stable: true };
        f.gateway._syncTaskHistoryMirror(parent);
        assert.strictEqual(f.history._persistNow(), true);
        const staleHistory = fs.readFileSync(path.join(dir, 'history.json'));
        const response = await f.gateway._continueReviewedTask(parent.taskId, parent, 'approve');
        const childId = response.nextTaskId;
        const stored = f.service.taskStore.load();
        assert.deepStrictEqual(stored.tasks.map(task => task.taskId), [childId], 'parent removal and child acceptance share a durable snapshot');
        if (boundary === 'trimmed history and events') {
          f.history.maxSize = 1;
          f.history.ensureTask('unrelated-history', 'New unrelated work', { createdAtMs: Date.now() + 1 });
          assert.strictEqual(f.history.getTask(parent.taskId), null);
          f.events.maxEvents = 1;
          f.events.append({ taskId: 'unrelated-event', type: 'task.completed', status: 'done', terminal: true });
          assert.strictEqual(f.events.events.some(event => event.taskId === parent.taskId), false);
        }
        if (boundary === 'legacy child without completion proof') {
          delete stored.tasks[0].workflowParentCompleted;
          assert.strictEqual(f.service.taskStore.writeTasks(stored.tasks), true);
        }
        f.close();
        if (boundary !== 'trimmed history and events') fs.writeFileSync(path.join(dir, 'history.json'), staleHistory);
        f = setup(dir, 'gateway');
        assert.strictEqual(f.service.restore(f.queue), 1);
        const child = f.queue.get(childId);
        assert.strictEqual(child.workflowParentTaskId, parent.taskId);
        assert.strictEqual(f.gateway._workflowDependencyConfirmed(child), true, 'the original child must not depend on retained history');
        assert.strictEqual(f.service.taskStore.load().tasks[0].workflowParentCompleted, true);
        let poll;
        const sends = [];
        f.gateway._setInterval = callback => { poll = callback; return { unref() {} }; };
        f.gateway._ensureConnection = async () => {};
        f.gateway._prepareQueuedTask = async () => {};
        f.gateway._captureTaskSoloChat = async () => {};
        f.gateway.driver = {
          checkQueueStatus: async () => ({ running: false, queued: false, canSubmit: true }),
          newChat: async () => {},
          sendMessage: async message => { sends.push([child.taskId, message]); },
          collectResponse: async () => ({ text: 'Original followup complete', stable: true })
        };
        delete f.gateway._ensureBackgroundPolling;
        f.gateway._ensureBackgroundPolling();
        await poll();
        await poll();
        assert.strictEqual(child.status, 'done');
        assert.deepStrictEqual(sends, [[childId, 'Run the original followup']]);
        assert.strictEqual(f.created(), 0, 'restart must not recreate either workflow identity');
      } finally {
        f.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  await r.asyncTest('unconfirmed workflow parents remain blocked after restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-workflow-blocked-'));
    let f = setup(dir, 'gateway');
    try {
      const parent = f.gateway._createQueuedTask({ task: 'Unconfirmed parent' });
      const child = f.gateway._createQueuedTask({ task: 'Dependent work' });
      child.workflowParentTaskId = parent.taskId;
      assert.strictEqual(f.service.persist(f.queue), true);
      f.close();
      f = setup(dir, 'gateway');
      assert.strictEqual(f.service.restore(f.queue), 2);
      assert.strictEqual(f.gateway._workflowDependencyConfirmed(f.queue.get(child.taskId)), false);
      assert.strictEqual(f.queue.get(child.taskId).workflowParentCompleted, undefined);
    } finally {
      f.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await r.asyncTest('both mirrors preserve stored links on partial updates and keep unrelated tasks unlinked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-workflow-metadata-'));
    const f = setup(dir, 'gateway');
    try {
      const task = { taskId: 'stored-workflow-link', task: 'Keep original workflow identity', status: 'executing', createdAt: Date.now() };
      f.history.ensureTask(task.taskId, task.task, { metadata: {
        nextTaskId: 'original-child', workflowParentTaskId: 'original-parent', custom: { retained: true }
      } });
      for (const sync of [f.gateway._syncTaskHistoryMirror.bind(f.gateway), f.service.syncHistoryMirror.bind(f.service)]) {
        sync(task);
        const metadata = f.history.getTask(task.taskId).metadata;
        assert.strictEqual(metadata.nextTaskId, 'original-child');
        assert.strictEqual(metadata.workflowParentTaskId, 'original-parent');
        assert.deepStrictEqual(metadata.custom, { retained: true });
        const standalone = { taskId: `standalone-${f.history.tasks.size}`, task: 'Unrelated standalone work', status: 'queued',
          createdAt: Date.now(), nextTaskId: 12, workflowParentTaskId: ' ' };
        sync(standalone);
        const standaloneMetadata = f.history.getTask(standalone.taskId).metadata;
        assert.strictEqual(standaloneMetadata.nextTaskId, undefined);
        assert.strictEqual(standaloneMetadata.workflowParentTaskId, undefined);
      }
    } finally {
      f.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  r.summary();
  if (r.failed) process.exitCode = 1;
});
