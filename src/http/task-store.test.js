'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TaskQueueService } = require('./task-queue-service');
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
