'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TaskQueueService } = require('./task-queue-service');
const { TASK_STORE_LOCK_METADATA_GRACE_MS } = require('./task-store');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('task-store.test.js');
const { asyncTest, pendingAsyncTests, summary } = runner;

function createService(persistencePath, options = {}) {
  return new TaskQueueService({
    persistencePath,
    isTerminalStatus: status => ['done', 'error', 'cancelled'].includes(status),
    ...options
  });
}

async function writeTwoSnapshots(persistencePath) {
  const service = createService(persistencePath);
  try {
    const queue = new Map([
      ['task-stable', {
        taskId: 'task-stable',
        status: 'queued',
        task: 'first durable snapshot',
        createdAt: 1000
      }]
    ]);
    await service.persist(queue);
    queue.get('task-stable').task = 'second durable snapshot';
    await service.persist(queue);
  } finally {
    service.close();
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

asyncTest('TaskQueueService writes checksummed snapshots and preserves last-known-good', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-format-'));
  const persistencePath = path.join(dir, 'active-queue.json');
  try {
    await writeTwoSnapshots(persistencePath);

    const primary = readJson(persistencePath);
    const backup = readJson(`${persistencePath}.bak`);
    assert.strictEqual(primary.schemaVersion, 2);
    assert.strictEqual(primary.checksum.algorithm, 'sha256');
    assert.match(primary.checksum.digest, /^[a-f0-9]{64}$/);
    assert.strictEqual(primary.tasks[0].task, 'second durable snapshot');
    assert.strictEqual(backup.tasks[0].task, 'first durable snapshot');
    assert.strictEqual(fs.existsSync(`${persistencePath}.tmp`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService quarantines a corrupt primary and restores last-known-good', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-recovery-'));
  const persistencePath = path.join(dir, 'active-queue.json');
  try {
    await writeTwoSnapshots(persistencePath);
    fs.writeFileSync(persistencePath, '{"schemaVersion":2,', 'utf8');

    const restoredQueue = new Map();
    const restored = createService(persistencePath).restore(restoredQueue);

    assert.strictEqual(restored, 1);
    assert.strictEqual(restoredQueue.get('task-stable').task, 'first durable snapshot');
    assert.strictEqual(readJson(persistencePath).schemaVersion, 2);
    assert.ok(
      fs.readdirSync(dir).some(name => /^active-queue\.json\.corrupt-/.test(name)),
      'corrupt primary should be retained in quarantine'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService rejects a checksum-mismatched primary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-checksum-'));
  const persistencePath = path.join(dir, 'active-queue.json');
  try {
    await writeTwoSnapshots(persistencePath);
    const tampered = readJson(persistencePath);
    tampered.tasks[0].task = 'tampered without updating checksum';
    fs.writeFileSync(persistencePath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    const restoredQueue = new Map();
    const restored = createService(persistencePath).restore(restoredQueue);

    assert.strictEqual(restored, 1);
    assert.strictEqual(restoredQueue.get('task-stable').task, 'first durable snapshot');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService reports degraded durability after a snapshot write fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-health-'));
  const blockingFile = path.join(dir, 'not-a-directory');
  const persistencePath = path.join(blockingFile, 'active-queue.json');
  fs.writeFileSync(blockingFile, 'blocks mkdir', 'utf8');
  try {
    const service = createService(persistencePath, {
      logger: { error() {}, warn() {} }
    });
    const queue = new Map([['task-write-failure', {
      taskId: 'task-write-failure',
      status: 'queued',
      task: 'must be durable before acceptance',
      createdAt: Date.now()
    }]]);

    assert.strictEqual(service.persist(queue), false);
    const health = typeof service.getPersistenceHealth === 'function'
      ? service.getPersistenceHealth()
      : null;
    assert.ok(health, 'persistence health must be available to the gateway');
    assert.strictEqual(health.taskStoreWritable, false);
    assert.strictEqual(health.durabilityDegraded, true);
    assert.strictEqual(health.lastSuccessfulPersistAt, null);
    assert.ok(health.lastPersistError);
    assert.match(health.lastPersistError.code, /^(?:EEXIST|ENOTDIR|WRITE_FAILED)$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService reports each expected filesystem durability failure', async () => {
  for (const code of ['ENOSPC', 'EACCES', 'EROFS']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `traecn-task-store-${code.toLowerCase()}-`));
    const persistencePath = path.join(dir, 'active-queue.json');
    const service = createService(persistencePath, {
      logger: { error() {}, warn() {} },
      onWritePhase(phase) {
        if (phase !== 'temp_opened') return;
        const error = new Error(`injected ${code}`);
        error.code = code;
        throw error;
      }
    });
    try {
      const queue = new Map([[`task-${code.toLowerCase()}`, {
        taskId: `task-${code.toLowerCase()}`,
        status: 'queued',
        task: `must not be accepted after ${code}`,
        createdAt: Date.now()
      }]]);

      assert.strictEqual(service.persist(queue), false, code);
      assert.deepStrictEqual(service.getPersistenceHealth().lastPersistError.code, code);
      assert.strictEqual(fs.existsSync(persistencePath), false, `${code}: primary snapshot exists`);
    } finally {
      service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

asyncTest('TaskQueueService prevents a second process from owning the same active store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-lock-'));
  const persistencePath = path.join(dir, 'active-queue.json');
  const service = createService(persistencePath);
  const queue = new Map([['task-owner', {
    taskId: 'task-owner',
    status: 'queued',
    task: 'owned by the first gateway',
    createdAt: Date.now()
  }]]);
  const servicePath = require.resolve('./task-queue-service');
  const childSource = `
    'use strict';
    const { TaskQueueService } = require(${JSON.stringify(servicePath)});
    const service = new TaskQueueService({
      persistencePath: process.argv[1],
      isTerminalStatus: () => false,
      logger: { error() {}, warn() {}, log() {} }
    });
    const queue = new Map([['task-contender', {
      taskId: 'task-contender',
      status: 'queued',
      task: 'must not replace the owner snapshot',
      createdAt: Date.now()
    }]]);
    const persisted = service.persist(queue);
    process.stdout.write(JSON.stringify({ persisted, health: service.getPersistenceHealth() }));
  `;

  try {
    assert.strictEqual(service.persist(queue), true);
    const contender = spawnSync(process.execPath, ['-e', childSource, persistencePath], {
      encoding: 'utf8'
    });
    assert.strictEqual(contender.status, 0, contender.stderr);
    const result = JSON.parse(contender.stdout);
    assert.strictEqual(result.persisted, false);
    assert.strictEqual(result.health.taskStoreWritable, false);
    assert.strictEqual(result.health.lastPersistError.code, 'TASK_STORE_LOCKED');
    assert.strictEqual(readJson(persistencePath).tasks[0].taskId, 'task-owner');
  } finally {
    if (typeof service.close === 'function') service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService does not steal a fresh malformed lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-fresh-malformed-lock-'));
  const persistencePath = path.join(dir, 'active-queue.json');
  const lockPath = `${persistencePath}.lock`;
  fs.writeFileSync(lockPath, '{', 'utf8');
  const service = createService(persistencePath, {
    logger: { error() {}, warn() {} }
  });
  try {
    const queue = new Map([['task-fresh-lock', {
      taskId: 'task-fresh-lock',
      status: 'queued',
      task: 'must wait for fresh lock metadata',
      createdAt: Date.now()
    }]]);

    assert.strictEqual(service.persist(queue), false);
    assert.strictEqual(service.getPersistenceHealth().lastPersistError.code, 'TASK_STORE_LOCKED');
    assert.strictEqual(fs.existsSync(persistencePath), false);
    assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), '{');
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService reclaims a stale malformed lock left before metadata commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-stale-malformed-lock-'));
  const persistencePath = path.join(dir, 'active-queue.json');
  const lockPath = `${persistencePath}.lock`;
  fs.writeFileSync(lockPath, '{', 'utf8');
  const staleAt = new Date(Date.now() - TASK_STORE_LOCK_METADATA_GRACE_MS - 1000);
  fs.utimesSync(lockPath, staleAt, staleAt);
  const service = createService(persistencePath);
  try {
    const queue = new Map([['task-after-incomplete-lock', {
      taskId: 'task-after-incomplete-lock',
      status: 'queued',
      task: 'recover ownership after lock metadata was interrupted',
      createdAt: Date.now()
    }]]);

    assert.strictEqual(service.persist(queue), true);
    assert.strictEqual(readJson(persistencePath).tasks[0].taskId, 'task-after-incomplete-lock');
    const lock = readJson(lockPath);
    assert.strictEqual(lock.pid, process.pid);
    assert.match(lock.ownerId, /^[a-f0-9]{32}$/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService reclaims a single-writer lock left by a dead process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-store-stale-lock-'));
  const persistencePath = path.join(dir, 'active-queue.json');
  fs.writeFileSync(`${persistencePath}.lock`, `${JSON.stringify({
    pid: 2147483647,
    ownerId: 'dead-process-owner',
    acquiredAt: '2026-01-01T00:00:00.000Z'
  })}\n`, 'utf8');
  const service = createService(persistencePath);
  try {
    const queue = new Map([['task-after-crash', {
      taskId: 'task-after-crash',
      status: 'queued',
      task: 'recover ownership after a gateway crash',
      createdAt: Date.now()
    }]]);
    assert.strictEqual(service.persist(queue), true);
    assert.strictEqual(readJson(persistencePath).tasks[0].taskId, 'task-after-crash');
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asyncTest('TaskQueueService survives a forced process kill at every atomic write phase', async () => {
  const phases = [
    'temp_opened',
    'temp_written',
    'temp_fsynced',
    'backup_committed',
    'primary_committed',
    'directory_fsynced'
  ];
  const servicePath = require.resolve('./task-queue-service');
  const childSource = `
    'use strict';
    const { TaskQueueService } = require(${JSON.stringify(servicePath)});
    const persistencePath = process.argv[1];
    const crashPhase = process.argv[2];
    const service = new TaskQueueService({
      persistencePath,
      isTerminalStatus: () => false,
      onWritePhase(phase) {
        if (phase === crashPhase) process.kill(process.pid, 'SIGKILL');
      }
    });
    const queue = new Map([['task-crash', {
      taskId: 'task-crash',
      status: 'queued',
      task: 'new snapshot from crashing writer',
      createdAt: 2000
    }]]);
    Promise.resolve(service.persist(queue)).then(() => process.exit(0));
  `;

  for (const phase of phases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `traecn-task-store-crash-${phase}-`));
    const persistencePath = path.join(dir, 'active-queue.json');
    try {
      await writeTwoSnapshots(persistencePath);
      const writer = spawnSync(process.execPath, ['-e', childSource, persistencePath, phase], {
        encoding: 'utf8'
      });
      assert.strictEqual(writer.signal, 'SIGKILL', `${phase}: writer did not stop at the requested phase`);

      const restoredQueue = new Map();
      const restored = createService(persistencePath).restore(restoredQueue);
      assert.strictEqual(restored, 1, `${phase}: no complete snapshot was restored`);
      const restoredTask = restoredQueue.values().next().value;
      const expectedTask = ['primary_committed', 'directory_fsynced'].includes(phase)
        ? 'new snapshot from crashing writer'
        : 'second durable snapshot';
      assert.strictEqual(restoredTask.task, expectedTask, phase);
      assert.strictEqual(fs.existsSync(`${persistencePath}.tmp`), false, `${phase}: stale temp file remains`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
});
