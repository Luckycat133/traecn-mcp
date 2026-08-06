'use strict';

const assert = require('assert');
const { createRunner } = require('../shared/test-runner');
const { TaskOrchestrator } = require('./task-orchestrator');

const r = createRunner('task-orchestrator.test.js');
const { test, summary } = r;

console.log('\n[task-orchestrator.test.js] Running tests...\n');

function createDependencies({ persist = true, persistError = null } = {}) {
  const history = {
    created: [],
    steps: [],
    failed: [],
    createTask(_sessionId, task, options) {
      this.created.push({ task, options });
      return 'task-accepted-1';
    },
    recordStep(taskId, step, payload) {
      this.steps.push({ taskId, step, payload });
    },
    failTask(taskId, error) {
      this.failed.push({ taskId, error });
    },
  };
  const taskQueue = new Map();
  const queueService = {
    persisted: 0,
    persist() {
      this.persisted += 1;
      if (persistError) throw persistError;
      return persist;
    },
    getPersistenceHealth() {
      return { taskStoreWritable: false, lastPersistError: { code: 'ENOSPC' } };
    },
  };
  return { history, taskQueue, queueService };
}

function createOrchestrator(dependencies, overrides = {}) {
  return new TaskOrchestrator({
    taskHistoryStore: dependencies.history,
    taskQueue: dependencies.taskQueue,
    taskQueueService: dependencies.queueService,
    getDriverConfig: () => ({ queuePerTaskTimeoutMs: 1000, queueMaxWaitMs: 5000 }),
    normalizeFollowupTasks: () => [{ task: 'follow-up', reviewRequired: true }],
    normalizeCompletionChecks: () => ({ requiredFiles: [], requiredText: [] }),
    hasCompletionChecks: () => false,
    normalizeFallbackModels: () => ['fallback-model'],
    modelProbeIntervalMs: () => 15000,
    normalizeAutoApproveDialog: () => 'auto',
    normalizeSoloChatTarget: () => ({ index: 2 }),
    syncTaskHistoryMirror: (task) => {
      task.mirrored = true;
    },
    now: () => 1000000,
    ...overrides,
  });
}

test('TaskOrchestrator exposes candidate acceptance as an injectable boundary', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies);
  const task = orchestrator.createQueuedTask(
    {
      task: 'implement the requested change',
      sessionId: 'session-1',
      idempotencyKey: 'retry-safe-1',
      projectPath: '/workspace/project',
      reviewRequired: true,
      autoContinue: true,
      followupTasks: ['ignored-by-normalizer'],
      autoApproveDialog: true,
      soloChatIndex: 2,
      fallbackModels: ['ignored-by-normalizer'],
      maxQueueWaitMs: 3000,
    },
    { queued: true, queuePosition: 4, queueMessage: 'waiting' }
  );

  assert.strictEqual(task.taskId, 'task-accepted-1');
  assert.strictEqual(task.status, 'queued');
  assert.strictEqual(task.createdAt, 1000000);
  assert.strictEqual(task.deadline, 1001000);
  assert.strictEqual(task.maxDeadline, 1003000);
  assert.strictEqual(task.idempotencyKey, 'retry-safe-1');
  assert.deepStrictEqual(task.followupTasks, [{ task: 'follow-up', reviewRequired: true }]);
  assert.deepStrictEqual(task.soloChat, { index: 2 });
  assert.strictEqual(task.mirrored, true);
  assert.strictEqual(dependencies.taskQueue.get(task.taskId), task);
  assert.strictEqual(dependencies.queueService.persisted, 1);
  assert.strictEqual(dependencies.history.steps[0].step, 'queued');
});

test('TaskOrchestrator rolls back candidate acceptance when persistence fails', () => {
  const dependencies = createDependencies({ persist: false });
  const orchestrator = createOrchestrator(dependencies);

  assert.throws(
    () => orchestrator.createQueuedTask({ task: 'must not be accepted' }, { queued: true }),
    (error) => {
      assert.strictEqual(error.code, 'TASK_STORE_UNAVAILABLE');
      return true;
    }
  );
  assert.strictEqual(dependencies.taskQueue.size, 0);
  assert.strictEqual(dependencies.history.failed.length, 1);
  assert.strictEqual(dependencies.history.failed[0].taskId, 'task-accepted-1');
});

test('TaskOrchestrator rolls back candidate acceptance when persistence throws', () => {
  const dependencies = createDependencies({
    persistError: new Error('disk write interrupted'),
  });
  const orchestrator = createOrchestrator(dependencies);

  assert.throws(
    () => orchestrator.createQueuedTask({ task: 'must roll back after thrown persistence' }),
    /disk write interrupted/
  );
  assert.strictEqual(dependencies.taskQueue.size, 0);
  assert.strictEqual(dependencies.history.failed.length, 1);
  assert.strictEqual(dependencies.history.failed[0].taskId, 'task-accepted-1');
});

test('TaskOrchestrator resolveIdempotentTask replays an accepted task as HTTP 202', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies, {
    isTerminalStatus: (status) => ['done', 'error', 'cancelled'].includes(status)
  });
  const task = orchestrator.createQueuedTask(
    { task: 'replay me', idempotencyKey: 'retry-safe-2' },
    { queued: true }
  );

  const replay = orchestrator.resolveIdempotentTask('retry-safe-2');
  assert.deepStrictEqual(replay, {
    taskId: task.taskId,
    status: 'accepted',
    statusCode: 202
  });
  // The replay must not create a duplicate task.
  assert.strictEqual(dependencies.taskQueue.size, 1);
});

test('TaskOrchestrator resolveIdempotentTask reports the real terminal status once finished', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies, {
    isTerminalStatus: (status) => ['done', 'error', 'cancelled'].includes(status)
  });
  const task = orchestrator.createQueuedTask(
    { task: 'already finished', idempotencyKey: 'terminal-replay-2' },
    { queued: true }
  );
  task.status = 'done';

  const replay = orchestrator.resolveIdempotentTask('terminal-replay-2');
  assert.ok(replay);
  assert.strictEqual(replay.taskId, task.taskId);
  assert.strictEqual(replay.status, 'done');
  assert.strictEqual(replay.statusCode, 202);
});

test('TaskOrchestrator resolveIdempotentTask returns null for an unknown or empty key', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies);
  orchestrator.createQueuedTask(
    { task: 'owned task', idempotencyKey: 'owned-key' },
    { queued: true }
  );

  assert.strictEqual(orchestrator.resolveIdempotentTask('never-seen'), null);
  assert.strictEqual(orchestrator.resolveIdempotentTask(''), null);
  assert.strictEqual(orchestrator.resolveIdempotentTask(null), null);
  assert.strictEqual(dependencies.taskQueue.size, 1);
});

summary();
if (r.failed > 0) process.exit(1);
