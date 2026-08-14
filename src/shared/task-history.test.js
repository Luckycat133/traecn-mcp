'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_HISTORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-suite-'));
const TEST_HISTORY_PATH = path.join(TEST_HISTORY_DIR, 'task-history.json');
process.env.TRAECN_TASK_HISTORY_PERSISTENCE_PATH = TEST_HISTORY_PATH;
try {
  fs.unlinkSync(TEST_HISTORY_PATH);
} catch {}

const { TaskHistoryStore, getGlobalStore, resetGlobalStore } = require('./task-history');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('task-history.test.js');
const _baseTest = r.test;
const { asyncTest, pendingAsyncTests, summary } = r;

function resetPersistentState() {
  resetGlobalStore();
  for (const suffix of ['', '.bak', '.tmp', '.bak.tmp']) {
    try {
      fs.unlinkSync(`${TEST_HISTORY_PATH}${suffix}`);
    } catch {}
  }
  for (const name of fs.readdirSync(TEST_HISTORY_DIR)) {
    if (name.startsWith(`${path.basename(TEST_HISTORY_PATH)}.corrupt-`)) {
      fs.unlinkSync(path.join(TEST_HISTORY_DIR, name));
    }
  }
}

function silentLogger() {
  return { error: () => {}, warn: () => {}, log: () => {} };
}

function documentChecksum(document) {
  const payload = {
    schemaVersion: document.schemaVersion,
    savedAt: document.savedAt,
    tasks: document.tasks
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// Wrap the runner's test() so each case resets persistent state around it —
// preserves the original "clean slate per test" guarantee.
function test(name, fn) {
  _baseTest(name, () => {
    resetPersistentState();
    let result;
    try {
      result = fn();
    } catch (error) {
      resetPersistentState();
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return result.finally(resetPersistentState);
    }
    resetPersistentState();
    return result;
  });
}

console.log('\n[task-history.test.js] Running tests...\n');

test('createTask returns a taskId', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask('session1', 'Test task');
  assert.ok(taskId, 'taskId should be truthy');
  assert.ok(taskId.startsWith('task_'), 'taskId should start with "task_"');
  store.shutdown();
});

test('createTask stores task with correct fields', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask('session1', 'My test task');
  const task = store.getTask(taskId);
  assert.strictEqual(task.task, 'My test task');
  assert.strictEqual(task.sessionId, 'session1');
  assert.strictEqual(task.status, 'running');
  assert.ok(task.createdAt, 'should have createdAt');
  assert.strictEqual(task.completedAt, null);
  assert.deepStrictEqual(task.steps, []);
  store.shutdown();
});

test('ensureTask upserts a provided task record when missing', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const record = store.ensureTask('task_existing_1', 'Queued task', {
    status: 'running',
    createdAtMs: 1234,
    createdAt: new Date(1234).toISOString(),
    metadata: { source: 'restore' }
  });
  assert.strictEqual(record.taskId, 'task_existing_1');
  assert.strictEqual(store.getTask('task_existing_1').metadata.source, 'restore');
  store.shutdown();
});

test('ensureTask updates an existing record when updateExisting is true', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.ensureTask('task_existing_2', 'Queued task', {
    status: 'queued',
    createdAtMs: 1234,
    createdAt: new Date(1234).toISOString()
  });
  const updated = store.ensureTask('task_existing_2', 'Queued task updated', {
    updateExisting: true,
    status: 'awaiting_review',
    result: { text: 'review me' },
    completedAt: new Date(5678).toISOString(),
    elapsedMs: 444
  });
  assert.strictEqual(updated.status, 'awaiting_review');
  assert.strictEqual(updated.task, 'Queued task updated');
  assert.strictEqual(updated.result.text, 'review me');
  assert.strictEqual(updated.elapsedMs, 444);
  store.shutdown();
});

test('createTask truncates long task strings', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const longTask = 'x'.repeat(15000);
  const taskId = store.createTask(null, longTask);
  const task = store.getTask(taskId);
  assert.strictEqual(task.task.length, 10000);
  store.shutdown();
});

test('recordStep adds step to task', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask(null, 'Task');
  const step = store.recordStep(taskId, 'CDP.send', { duration: 50, success: true });
  assert.ok(step, 'step should be returned');
  assert.strictEqual(step.action, 'CDP.send');
  assert.strictEqual(step.duration, 50);
  assert.strictEqual(step.success, true);
  const task = store.getTask(taskId);
  assert.strictEqual(task.steps.length, 1);
  store.shutdown();
});

test('recordStep returns null for unknown taskId', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const step = store.recordStep('unknown-id', 'action');
  assert.strictEqual(step, null);
  store.shutdown();
});

test('completeTask updates task status and result', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask(null, 'Task');
  store.recordStep(taskId, 'action1');
  const result = { text: 'Done!' };
  store.completeTask(taskId, result, { elapsedMs: 1000 });
  const task = store.getTask(taskId);
  assert.strictEqual(task.status, 'completed');
  assert.deepStrictEqual(task.result, result);
  assert.strictEqual(task.elapsedMs, 1000);
  assert.ok(task.completedAt);
  store.shutdown();
});

test('failTask updates task status to failed', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask(null, 'Task');
  store.failTask(taskId, new Error('Something went wrong'));
  const task = store.getTask(taskId);
  assert.strictEqual(task.status, 'failed');
  assert.deepStrictEqual(task.result, { error: 'Something went wrong' });
  assert.ok(task.completedAt);
  store.shutdown();
});

test('failTask handles string errors', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask(null, 'Task');
  store.failTask(taskId, 'Simple error string');
  const task = store.getTask(taskId);
  assert.strictEqual(task.status, 'failed');
  assert.deepStrictEqual(task.result, { error: 'Simple error string' });
  store.shutdown();
});

test('cancelTask updates task status to cancelled', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask(null, 'Task');
  store.cancelTask(taskId);
  const task = store.getTask(taskId);
  assert.strictEqual(task.status, 'cancelled');
  assert.ok(task.completedAt);
  store.shutdown();
});

test('getTask returns null for unknown taskId', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const task = store.getTask('unknown-id');
  assert.strictEqual(task, null);
  store.shutdown();
});

test('getHistory returns paginated results', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  for (let i = 0; i < 25; i++) {
    const id = store.createTask(null, `Task ${i}`);
    store.completeTask(id, { text: `Result ${i}` });
  }
  const result = store.getHistory({ page: 1, limit: 10 });
  assert.strictEqual(result.tasks.length, 10);
  assert.strictEqual(result.pagination.total, 25);
  assert.strictEqual(result.pagination.totalPages, 3);
  assert.strictEqual(result.pagination.hasNext, true);
  assert.strictEqual(result.pagination.hasPrev, false);
  store.shutdown();
});

test('getHistory pagination page 2', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  for (let i = 0; i < 25; i++) {
    const id = store.createTask(null, `Task ${i}`);
    store.completeTask(id, { text: `Result ${i}` });
  }
  const result = store.getHistory({ page: 2, limit: 10 });
  assert.strictEqual(result.tasks.length, 10);
  assert.strictEqual(result.pagination.page, 2);
  assert.strictEqual(result.pagination.hasPrev, true);
  store.shutdown();
});

test('getHistory filter by status', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const id1 = store.createTask(null, 'Task 1');
  store.completeTask(id1, {});
  const id2 = store.createTask(null, 'Task 2');
  store.failTask(id2, 'error');
  const id3 = store.createTask(null, 'Task 3');
  const result = store.getHistory({ status: 'completed' });
  assert.strictEqual(result.tasks.length, 1);
  assert.strictEqual(result.tasks[0].taskId, id1);
  store.shutdown();
});

test('getHistory filter by keyword', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.createTask(null, 'Deploy application');
  store.createTask(null, 'Fix bug in login');
  store.createTask(null, 'Update documentation');
  const result = store.getHistory({ keyword: 'deploy' });
  assert.strictEqual(result.tasks.length, 1);
  assert.strictEqual(result.tasks[0].task, 'Deploy application');
  store.shutdown();
});

test('getHistory filter by keyword in result', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const id1 = store.createTask(null, 'Do something');
  store.completeTask(id1, { text: 'Deployment successful' });
  store.createTask(null, 'Do other thing');
  const result = store.getHistory({ keyword: 'deployment' });
  assert.strictEqual(result.tasks.length, 1);
  assert.strictEqual(result.tasks[0].taskId, id1);
  store.shutdown();
});

test('getHistory filter by date range', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.createTask(null, 'Old task');
  const pastDate = new Date(Date.now() - 60000).toISOString();
  const result = store.getHistory({ startDate: pastDate });
  assert.strictEqual(result.tasks.length, 1);
  store.shutdown();
});

test('getHistory filter by sessionId', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.createTask('session-a', 'Task A');
  store.createTask('session-b', 'Task B');
  store.createTask('session-a', 'Task C');
  const result = store.getHistory({ sessionId: 'session-a' });
  assert.strictEqual(result.tasks.length, 2);
  store.shutdown();
});

test('getReplay returns task with steps and summary', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask('session1', 'My task');
  store.recordStep(taskId, 'click', { duration: 100, success: true });
  store.recordStep(taskId, 'type', { duration: 200, success: true });
  store.recordStep(taskId, 'submit', { duration: 50, success: false, error: 'Network error' });
  store.completeTask(taskId, { text: 'Done' });
  const replay = store.getReplay(taskId);
  assert.strictEqual(replay.taskId, taskId);
  assert.strictEqual(replay.steps.length, 3);
  assert.strictEqual(replay.summary.totalSteps, 3);
  assert.strictEqual(replay.summary.successfulSteps, 2);
  assert.strictEqual(replay.summary.failedSteps, 1);
  assert.strictEqual(replay.summary.totalDuration, 350);
  store.shutdown();
});

test('getReplay returns null for unknown taskId', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const replay = store.getReplay('unknown-id');
  assert.strictEqual(replay, null);
  store.shutdown();
});

test('clearHistory deletes all tasks when no options', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.createTask(null, 'Task 1');
  store.createTask(null, 'Task 2');
  const result = store.clearHistory();
  assert.strictEqual(result.deleted, 2);
  assert.strictEqual(store.tasks.size, 0);
  store.shutdown();
});

test('clearHistory deletes by status', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const id1 = store.createTask(null, 'Task 1');
  store.completeTask(id1, {});
  store.createTask(null, 'Task 2');
  const result = store.clearHistory({ status: 'running' });
  assert.strictEqual(result.deleted, 1);
  assert.strictEqual(store.tasks.size, 1);
  store.shutdown();
});

test('clearHistory deletes by olderThanHours', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.createTask(null, 'Task');
  const result = store.clearHistory({ olderThanHours: 0 });
  assert.strictEqual(result.deleted, 1);
  store.shutdown();
});

test('cleanup enforces retention policy', () => {
  const store = new TaskHistoryStore({ maxSize: 100, retentionHours: 0 });
  store.ensureTask('task_old_retention', 'Old task', {
    createdAtMs: Date.now() - 1000,
    createdAt: new Date(Date.now() - 1000).toISOString()
  });
  const result = store.cleanup();
  assert.strictEqual(result.deleted, 1);
  assert.strictEqual(store.tasks.size, 0);
  store.shutdown();
});

test('cleanup enforces max size', () => {
  const store = new TaskHistoryStore({ maxSize: 5 });
  for (let i = 0; i < 10; i++) {
    store.createTask(null, `Task ${i}`);
  }
  store.cleanup();
  assert.strictEqual(store.tasks.size, 5);
  store.shutdown();
});

test('getStats returns correct statistics', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.createTask(null, 'Task 1');
  const id2 = store.createTask(null, 'Task 2');
  store.completeTask(id2, {});
  const id3 = store.createTask(null, 'Task 3');
  store.failTask(id3, 'error');
  const stats = store.getStats();
  assert.strictEqual(stats.totalTasks, 3);
  assert.strictEqual(stats.byStatus.running, 1);
  assert.strictEqual(stats.byStatus.completed, 1);
  assert.strictEqual(stats.byStatus.failed, 1);
  assert.strictEqual(stats.totalSteps, 0);
  store.shutdown();
});

test('getGlobalStore returns singleton', () => {
  resetGlobalStore();
  const store1 = getGlobalStore();
  const store2 = getGlobalStore();
  assert.strictEqual(store1, store2);
  resetGlobalStore();
});

test('resetGlobalStore clears the singleton', () => {
  const store1 = getGlobalStore();
  resetGlobalStore();
  const store2 = getGlobalStore();
  assert.notStrictEqual(store1, store2);
  resetGlobalStore();
});

test('persistence writes to file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-test-'));
  const tmpFile = path.join(tmpDir, 'history.json');
  const store = new TaskHistoryStore({
    maxSize: 100,
    persistencePath: tmpFile
  });
  const taskId = store.createTask('session1', 'Persistent task');
  store.completeTask(taskId, { text: 'Done' });
  store._persistNow();
  const store2 = new TaskHistoryStore({
    maxSize: 100,
    persistencePath: tmpFile
  });
  const tasks = Array.from(store2.tasks.values());
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].task, 'Persistent task');
  assert.strictEqual(tasks[0].status, 'completed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  store.shutdown();
  store2.shutdown();
});

test('history persistence writes checksummed snapshots atomically and preserves a backup', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-atomic-'));
  const persistencePath = path.join(tmpDir, 'history.json');
  const store = new TaskHistoryStore({ maxSize: 100, persistencePath, logger: silentLogger() });

  try {
    const taskId = store.createTask(null, 'Atomic history');
    assert.strictEqual(store._persistNow(), true);
    store.recordStep(taskId, 'second-snapshot');
    assert.strictEqual(store._persistNow(), true);

    const primary = JSON.parse(fs.readFileSync(persistencePath, 'utf8'));
    const backup = JSON.parse(fs.readFileSync(`${persistencePath}.bak`, 'utf8'));
    assert.strictEqual(primary.schemaVersion, 2);
    assert.strictEqual(primary.checksum.algorithm, 'sha256');
    assert.strictEqual(primary.checksum.digest, documentChecksum(primary));
    assert.strictEqual(primary.tasks[0].steps.length, 1);
    assert.strictEqual(backup.tasks[0].steps.length, 0);
    assert.strictEqual(fs.existsSync(`${persistencePath}.tmp`), false);
    assert.strictEqual(fs.existsSync(`${persistencePath}.bak.tmp`), false);
  } finally {
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('history persistence quarantines a corrupt primary and recovers the backup', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-backup-'));
  const persistencePath = path.join(tmpDir, 'history.json');
  const store = new TaskHistoryStore({ maxSize: 100, persistencePath, logger: silentLogger() });
  let recovered;

  try {
    const taskId = store.createTask(null, 'Recoverable history');
    store._persistNow();
    store.recordStep(taskId, 'newer-primary-only');
    store._persistNow();
    fs.writeFileSync(persistencePath, '{corrupt-primary', 'utf8');

    recovered = new TaskHistoryStore({ maxSize: 100, persistencePath, logger: silentLogger() });
    assert.ok(recovered.getTask(taskId));
    assert.strictEqual(recovered.getTask(taskId).steps.length, 0);
    assert.strictEqual(recovered.getHealth().lastRecovery.source, 'backup');
    assert.strictEqual(recovered.getHealth().durabilityDegraded, false);
    assert.ok(fs.readdirSync(tmpDir).some(name => name.startsWith('history.json.corrupt-')));

    const rewritten = JSON.parse(fs.readFileSync(persistencePath, 'utf8'));
    assert.strictEqual(rewritten.checksum.digest, documentChecksum(rewritten));
  } finally {
    if (recovered) recovered.shutdown();
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('history persistence recovers a complete interrupted temporary snapshot', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-temp-'));
  const persistencePath = path.join(tmpDir, 'history.json');
  const store = new TaskHistoryStore({ maxSize: 100, persistencePath, logger: silentLogger() });
  let recovered;

  try {
    const taskId = store.createTask(null, 'Interrupted history');
    store._persistNow();
    fs.renameSync(persistencePath, `${persistencePath}.tmp`);

    recovered = new TaskHistoryStore({ maxSize: 100, persistencePath, logger: silentLogger() });
    assert.ok(recovered.getTask(taskId));
    assert.strictEqual(recovered.getHealth().lastRecovery.source, 'temp');
    assert.strictEqual(fs.existsSync(persistencePath), true);
    assert.strictEqual(fs.existsSync(`${persistencePath}.tmp`), false);
  } finally {
    if (recovered) recovered.shutdown();
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('history persistence migrates a legacy version 1 snapshot', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-legacy-'));
  const persistencePath = path.join(tmpDir, 'history.json');
  const legacyTask = {
    taskId: 'task_legacy_history',
    sessionId: null,
    task: 'Legacy history',
    result: null,
    status: 'running',
    createdAt: '2026-08-01T00:00:00.000Z',
    createdAtMs: 1754006400000,
    sortKey: '1754006400000',
    completedAt: null,
    elapsedMs: null,
    steps: [],
    metadata: {}
  };
  fs.writeFileSync(persistencePath, JSON.stringify({
    version: 1,
    savedAt: '2026-08-01T00:00:00.000Z',
    tasks: [legacyTask]
  }), 'utf8');
  const store = new TaskHistoryStore({ maxSize: 100, persistencePath, logger: silentLogger() });

  try {
    assert.ok(store.getTask(legacyTask.taskId));
    assert.strictEqual(store.getHealth().lastRecovery.source, 'legacy');
    const migrated = JSON.parse(fs.readFileSync(persistencePath, 'utf8'));
    assert.strictEqual(migrated.schemaVersion, 2);
    assert.strictEqual(migrated.checksum.digest, documentChecksum(migrated));
  } finally {
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('history persistence reports degraded health after a write failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-health-'));
  const blockedDir = path.join(tmpDir, 'not-a-directory');
  fs.writeFileSync(blockedDir, 'blocked', 'utf8');
  const store = new TaskHistoryStore({
    maxSize: 100,
    persistencePath: path.join(blockedDir, 'history.json'),
    logger: silentLogger()
  });

  try {
    store.createTask(null, 'Unwritable history');
    assert.strictEqual(store._persistNow(), false);
    const health = store.getHealth();
    assert.strictEqual(health.persistenceEnabled, true);
    assert.strictEqual(health.historyStoreWritable, false);
    assert.strictEqual(health.lastSuccessfulPersistAt, null);
    assert.match(health.lastPersistError.code, /EEXIST|ENOTDIR|WRITE_FAILED/);
    assert.strictEqual(health.lastPersistError.message, 'Task history persistence is unavailable');
    assert.ok(health.lastPersistError.at);
    assert.strictEqual(health.lastLoadError, null);
    assert.strictEqual(health.lastRecovery, null);
    assert.strictEqual(health.durabilityDegraded, true);
  } finally {
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('default persistence path is enabled when no explicit path is provided', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  assert.ok(store.persistencePath);
  assert.strictEqual(store.persistencePath, TEST_HISTORY_PATH);
  store.shutdown();
});

test('history tasks are sorted by createdAt descending', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  store.createTask(null, 'First');
  store.createTask(null, 'Second');
  store.createTask(null, 'Third');
  const result = store.getHistory();
  assert.strictEqual(result.tasks[0].task, 'Third');
  assert.strictEqual(result.tasks[2].task, 'First');
  store.shutdown();
});

test('task metadata is stored correctly', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const metadata = { source: 'api', userId: 'user123' };
  const taskId = store.createTask(null, 'Task', { metadata });
  const task = store.getTask(taskId);
  assert.deepStrictEqual(task.metadata, metadata);
  store.shutdown();
});

test('step details are stored correctly', () => {
  const store = new TaskHistoryStore({ maxSize: 100 });
  const taskId = store.createTask(null, 'Task');
  store.recordStep(taskId, 'action', {
    duration: 100,
    success: true,
    error: null,
    details: { selector: '#btn', value: 'click' }
  });
  const task = store.getTask(taskId);
  assert.deepStrictEqual(task.steps[0].details, { selector: '#btn', value: 'click' });
  store.shutdown();
});

asyncTest('recordStep schedules a step-only snapshot that survives restart', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-step-only-'));
  const persistencePath = path.join(tmpDir, 'history.json');
  const store = new TaskHistoryStore({
    maxSize: 100,
    persistencePath,
    persistDebounceMs: 10
  });
  let restored;

  try {
    const taskId = store.createTask(null, 'Step-only persistence');
    await new Promise(resolve => setTimeout(resolve, 30));
    store.recordStep(taskId, 'step-only');
    await new Promise(resolve => setTimeout(resolve, 30));

    restored = new TaskHistoryStore({ maxSize: 100, persistencePath });
    assert.strictEqual(restored.getTask(taskId).steps.length, 1);
    assert.strictEqual(restored.getTask(taskId).steps[0].action, 'step-only');
  } finally {
    if (restored) restored.shutdown();
    store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

(async () => {
  await pendingAsyncTests();
  summary();
  fs.rmSync(TEST_HISTORY_DIR, { recursive: true, force: true });
  process.exit(r.failed > 0 ? 1 : 0);
})();
