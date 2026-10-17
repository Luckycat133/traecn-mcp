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

test('TaskOrchestrator rejects an idempotency key reused for different work', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies);
  const task = orchestrator.createQueuedTask(
    { task: 'original semantic work', idempotencyKey: 'collision-key' },
    { queued: true }
  );

  const replay = orchestrator.resolveIdempotentTask('collision-key', {
    task: 'different semantic work',
    idempotencyKey: 'collision-key'
  });

  assert.deepStrictEqual(replay, {
    conflict: true,
    taskId: task.taskId,
    statusCode: 409,
    error: 'idempotency_key_conflict'
  });
  assert.strictEqual(dependencies.taskQueue.size, 1);
});

test('TaskOrchestrator fingerprints every supported conversation target alias', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies, {
    normalizeSoloChatTarget: (value) => value && Number.isInteger(value.index)
      ? { index: value.index }
      : null
  });
  const request = { task: 'work in the selected conversation', soloChatIndex: 2 };
  const task = orchestrator.createQueuedTask({ ...request, idempotencyKey: 'conversation-key' });

  assert.strictEqual(task.idempotencyFingerprint, orchestrator.fingerprintTaskRequest({
    task: request.task,
    soloChat: { index: 2 }
  }));
  const replay = orchestrator.resolveIdempotentTask('conversation-key', {
    ...request,
    soloChatIndex: 3
  });
  assert.strictEqual(replay.statusCode, 409, 'another conversation changes the accepted work');
});

test('TaskOrchestrator fingerprints normalized queue limits and model probe intervals', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies, {
    modelProbeIntervalMs: value => Number(value) || 60000
  });
  const request = {
    task: 'work with bounded queue waiting',
    idempotencyKey: 'queue-options-key',
    maxQueueWaitMs: 3000,
    modelProbeIntervalMs: 15000
  };
  orchestrator.createQueuedTask(request);

  assert.strictEqual(orchestrator.fingerprintTaskRequest(request), orchestrator.fingerprintTaskRequest({
    ...request,
    maxQueueWaitMs: undefined,
    queueMaxWaitMs: '3000',
    modelProbeIntervalMs: '15000'
  }));
  assert.strictEqual(orchestrator.resolveIdempotentTask('queue-options-key', {
    ...request,
    maxQueueWaitMs: 9000
  }).statusCode, 409);
  assert.strictEqual(orchestrator.resolveIdempotentTask('queue-options-key', {
    ...request,
    modelProbeIntervalMs: 30000
  }).statusCode, 409);
});

test('TaskOrchestrator replays legacy fingerprints while enforcing the fields they recorded', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies, {
    isTerminalStatus: status => status === 'done'
  });
  const request = { task: 'work accepted before the upgrade', idempotencyKey: 'legacy-key' };
  const task = orchestrator.createQueuedTask(request);
  task.idempotencyFingerprint = orchestrator.fingerprintTaskRequest(request, 1);
  delete task.idempotencyFingerprintVersion;
  assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-key', request).statusCode, 202);
  assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-key', {
    ...request,
    task: 'different work after the upgrade'
  }).statusCode, 409);

  dependencies.taskQueue.clear();
  dependencies.queueService.getTerminalReplay = () => ({
    taskId: task.taskId,
    status: 'done',
    fingerprint: task.idempotencyFingerprint,
    result: { text: 'legacy result' }
  });
  assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-key', request).statusCode, 200);
  assert.strictEqual(orchestrator.resolveIdempotentTask('legacy-key', {
    ...request,
    task: 'different terminal work after the upgrade'
  }).statusCode, 409);
});

test('TaskOrchestrator rejects different work against a terminal replay', () => {
  const dependencies = createDependencies();
  const orchestrator = createOrchestrator(dependencies, {
    isTerminalStatus: (status) => ['done', 'error', 'cancelled'].includes(status)
  });
  const task = orchestrator.createQueuedTask(
    { task: 'original terminal work', idempotencyKey: 'terminal-collision-key' },
    { queued: true }
  );
  dependencies.taskQueue.clear();
  dependencies.queueService.getTerminalReplay = () => ({
    idempotencyKey: 'terminal-collision-key',
    fingerprint: task.idempotencyFingerprint,
    taskId: task.taskId,
    status: 'done',
    result: { text: 'original result', stable: true },
    error: null
  });

  const replay = orchestrator.resolveIdempotentTask('terminal-collision-key', {
    task: 'different terminal work',
    idempotencyKey: 'terminal-collision-key'
  });

  assert.deepStrictEqual(replay, {
    conflict: true,
    taskId: task.taskId,
    statusCode: 409,
    error: 'idempotency_key_conflict'
  });
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
  task.result = { text: 'original finished result', stable: true };

  const replay = orchestrator.resolveIdempotentTask('terminal-replay-2');
  assert.ok(replay);
  assert.strictEqual(replay.taskId, task.taskId);
  assert.strictEqual(replay.status, 'done');
  assert.strictEqual(replay.statusCode, 200);
  assert.strictEqual(replay.terminal, true);
  assert.deepStrictEqual(replay.result, task.result);
  assert.strictEqual(replay.error, null);
});

test('TaskOrchestrator terminal replays keep stored traces internal without changing the original result', () => {
  for (const persistedReplay of [false, true]) {
    const dependencies = createDependencies();
    const orchestrator = createOrchestrator(dependencies, {
      isTerminalStatus: status => status === 'done'
    });
    const task = orchestrator.createQueuedTask(
      { task: 'finished trace task', idempotencyKey: 'stored-trace-replay' },
      { queued: true }
    );
    const result = { text: 'final answer', stable: true, traceText: 'original process' };
    task.status = 'done';
    task.result = result;
    if (persistedReplay) {
      dependencies.taskQueue.delete(task.taskId);
      dependencies.queueService.getTerminalReplay = () => ({
        taskId: task.taskId, status: 'done', result, error: null
      });
    }
    const replay = orchestrator.resolveIdempotentTask('stored-trace-replay');
    assert.strictEqual(replay.taskId, task.taskId);
    assert.strictEqual(replay.terminal, true);
    assert.deepStrictEqual(replay.result, { text: 'final answer', stable: true });
    assert.strictEqual(result.traceText, 'original process');
  }
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
