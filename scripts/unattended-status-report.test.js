'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectReport,
  renderMarkdown,
  summarizeActiveQueue,
  summarizeCleanupWatcher,
  summarizeLongQueueProof,
  CLEAN_LONG_QUEUE_RESULT_TOKEN,
  REPORT_STATUS,
  STATUS_MARKER
} = require('./unattended-status-report');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-unattended-status-test-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.map(value => JSON.stringify(value)).join('\n') + '\n');
}

function setMtime(filePath, timestampMs) {
  const date = new Date(timestampMs);
  fs.utimesSync(filePath, date, date);
}

test('summarizeActiveQueue returns not-present when file is missing', () => {
  const dir = tempDir();
  const missing = path.join(dir, 'active-queue.json');
  const summary = summarizeActiveQueue(missing);
  assert.strictEqual(summary.present, false);
  assert.strictEqual(summary.taskCount, 0);
  assert.deepStrictEqual(summary.tasks, []);
  assert.strictEqual(summary.path, missing);
});

test('summarizeActiveQueue parses tasks from active-queue.json fixture', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'active-queue.json');
  writeJson(filePath, {
    version: 1,
    savedAt: '2026-06-21T00:00:00.000Z',
    tasks: [
      { taskId: 'task_a', status: 'executing', createdAt: '2026-06-21T00:00:01.000Z', model: 'GLM-5.2' },
      { taskId: 'task_b', status: 'queued', createdAt: '2026-06-21T00:00:02.000Z' }
    ]
  });
  const summary = summarizeActiveQueue(filePath);
  assert.strictEqual(summary.present, true);
  assert.strictEqual(summary.version, 1);
  assert.strictEqual(summary.savedAt, '2026-06-21T00:00:00.000Z');
  assert.strictEqual(summary.taskCount, 2);
  assert.strictEqual(summary.tasks[0].taskId, 'task_a');
  assert.strictEqual(summary.tasks[0].status, 'executing');
  assert.strictEqual(summary.tasks[0].model, 'GLM-5.2');
  assert.strictEqual(summary.tasks[1].taskId, 'task_b');
});

test('summarizeActiveQueue handles corrupted JSON gracefully', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'active-queue.json');
  fs.writeFileSync(filePath, '{not valid json');
  const summary = summarizeActiveQueue(filePath);
  assert.strictEqual(summary.present, true);
  assert.ok(summary.error);
  assert.strictEqual(summary.taskCount, 0);
});

test('summarizeCleanupWatcher reports stale lock for dead pid', () => {
  const dir = tempDir();
  const lockFile = path.join(dir, 'cleanup-watch.lock');
  writeJson(lockFile, {
    pid: 99999999,
    startedAt: '2020-01-01T00:00:00.000Z',
    command: 'cleanup-queue'
  });
  const summary = summarizeCleanupWatcher(lockFile);
  assert.strictEqual(summary.lockFile, lockFile);
  assert.strictEqual(summary.running, false);
  assert.strictEqual(summary.stale, true);
  assert.strictEqual(summary.pid, 99999999);
  assert.ok(summary.message.includes('stale'));
});

test('summarizeCleanupWatcher reports running lock for current pid', () => {
  const dir = tempDir();
  const lockFile = path.join(dir, 'cleanup-watch.lock');
  writeJson(lockFile, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: 'cleanup-queue'
  });
  const summary = summarizeCleanupWatcher(lockFile);
  assert.strictEqual(summary.running, true);
  assert.strictEqual(summary.stale, false);
  assert.strictEqual(summary.pid, process.pid);
});

test('summarizeCleanupWatcher reports not running when lock is missing', () => {
  const dir = tempDir();
  const lockFile = path.join(dir, 'missing.lock');
  const summary = summarizeCleanupWatcher(lockFile);
  assert.strictEqual(summary.running, false);
  assert.strictEqual(summary.stale, false);
  assert.strictEqual(summary.pid, null);
  assert.ok(summary.message.includes('not running'));
});

test('summarizeLongQueueProof returns not-present when proof dir is empty', () => {
  const dir = tempDir();
  const summary = summarizeLongQueueProof(dir);
  assert.strictEqual(summary.present, false);
  assert.strictEqual(summary.artifactCount, 0);
  assert.strictEqual(summary.status, null);
  assert.strictEqual(summary.cleanLongQueueResultSeen, false);
});

test('summarizeLongQueueProof detects newest proof final report and clean_long_queue_result token', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_STATUS_REPORT';
  const finalFile = path.join(dir, `${marker}.final.json`);
  writeJson(finalFile, {
    status: 'done',
    marker,
    taskId: 'task_status_proof',
    result: {
      status: 'done',
      text: JSON.stringify({ token: marker, model: 'GLM-5.2', status: CLEAN_LONG_QUEUE_RESULT_TOKEN })
    }
  });
  const evidenceLog = path.join(dir, `${marker}.jsonl`);
  writeJsonl(evidenceLog, [
    { type: 'submit', data: { taskId: 'task_status_proof' } },
    { type: 'task_status', data: { status: 'done' } }
  ]);
  setMtime(finalFile, Date.now());

  const summary = summarizeLongQueueProof(dir);
  assert.strictEqual(summary.present, true);
  assert.strictEqual(summary.artifactCount, 2);
  assert.strictEqual(summary.status, 'done');
  assert.strictEqual(summary.marker, marker);
  assert.strictEqual(summary.taskId, 'task_status_proof');
  assert.strictEqual(summary.cleanLongQueueResultSeen, true);
});

test('summarizeLongQueueProof reports cleanLongQueueResultSeen false when token absent', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_NO_TOKEN';
  const finalFile = path.join(dir, `${marker}.final.json`);
  writeJson(finalFile, {
    status: 'error',
    marker,
    taskId: 'task_no_token',
    error: 'proof failed before completion'
  });
  setMtime(finalFile, Date.now());

  const summary = summarizeLongQueueProof(dir);
  assert.strictEqual(summary.present, true);
  assert.strictEqual(summary.status, 'error');
  assert.strictEqual(summary.cleanLongQueueResultSeen, false);
});

test('collectReport returns JSON shape with all required sections', async () => {
  const dir = tempDir();
  const activeQueuePath = path.join(dir, 'active-queue.json');
  writeJson(activeQueuePath, {
    version: 1,
    savedAt: '2026-06-21T00:00:00.000Z',
    tasks: [{ taskId: 'task_active', status: 'executing' }]
  });
  const cleanupLockFile = path.join(dir, 'cleanup-watch.lock');
  writeJson(cleanupLockFile, {
    pid: 99999999,
    startedAt: '2020-01-01T00:00:00.000Z',
    command: 'cleanup-queue'
  });
  const proofDir = path.join(dir, 'proofs');
  const marker = 'TRAECN_GLM52_CLEAN_REPORT_SHAPE';
  const finalFile = path.join(proofDir, `${marker}.final.json`);
  writeJson(finalFile, {
    status: 'done',
    marker,
    taskId: 'task_shape',
    result: { status: 'done', text: CLEAN_LONG_QUEUE_RESULT_TOKEN }
  });
  setMtime(finalFile, Date.now());

  const gatewayProbeFn = async () => ({
    reachable: true,
    host: '127.0.0.1',
    port: 8788,
    elapsedMs: 5,
    status: 200,
    ready: true,
    readiness: { ok: true },
    queue: { activeTasks: 0 }
  });

  const report = await collectReport({
    activeQueuePath,
    proofDir,
    cleanupLockFile,
    gatewayProbeFn
  });

  assert.strictEqual(report.status, REPORT_STATUS);
  assert.strictEqual(report.marker, STATUS_MARKER);
  assert.ok(report.generatedAt);

  assert.strictEqual(report.activeQueue.present, true);
  assert.strictEqual(report.activeQueue.taskCount, 1);
  assert.strictEqual(report.activeQueue.tasks[0].taskId, 'task_active');

  assert.strictEqual(report.cleanupWatcher.running, false);
  assert.strictEqual(report.cleanupWatcher.stale, true);
  assert.strictEqual(report.cleanupWatcher.lockFile, cleanupLockFile);

  assert.strictEqual(report.longQueueProof.present, true);
  assert.strictEqual(report.longQueueProof.status, 'done');
  assert.strictEqual(report.longQueueProof.marker, marker);
  assert.strictEqual(report.longQueueProof.cleanLongQueueResultSeen, true);

  assert.strictEqual(report.gateway.reachable, true);
  assert.strictEqual(report.gateway.ready, true);
});

test('collectReport degrades gracefully when gateway probe fails', async () => {
  const dir = tempDir();
  const gatewayProbeFn = async () => ({
    reachable: false,
    host: '127.0.0.1',
    port: 8788,
    elapsedMs: 3,
    status: null,
    error: 'connect ECONNREFUSED 127.0.0.1:8788'
  });

  const report = await collectReport({
    activeQueuePath: path.join(dir, 'active-queue.json'),
    proofDir: dir,
    cleanupLockFile: path.join(dir, 'cleanup-watch.lock'),
    gatewayProbeFn
  });

  assert.strictEqual(report.gateway.reachable, false);
  assert.strictEqual(report.gateway.host, '127.0.0.1');
  assert.ok(report.gateway.error.includes('ECONNREFUSED'));
  assert.strictEqual(report.activeQueue.present, false);
  assert.strictEqual(report.cleanupWatcher.running, false);
  assert.strictEqual(report.longQueueProof.present, false);
  assert.strictEqual(report.status, REPORT_STATUS);
});

test('collectReport skips gateway when skipGateway is true', async () => {
  const dir = tempDir();
  const report = await collectReport({
    activeQueuePath: path.join(dir, 'active-queue.json'),
    proofDir: dir,
    cleanupLockFile: path.join(dir, 'cleanup-watch.lock'),
    skipGateway: true
  });
  assert.strictEqual(report.gateway, null);
  assert.strictEqual(report.activeQueue.present, false);
});

test('renderMarkdown includes cleanup watcher, proof, active queue, and gateway sections', async () => {
  const dir = tempDir();
  const activeQueuePath = path.join(dir, 'active-queue.json');
  writeJson(activeQueuePath, {
    version: 1,
    savedAt: '2026-06-21T00:00:00.000Z',
    tasks: [{ taskId: 'task_md', status: 'executing', createdAt: '2026-06-21T00:00:01.000Z' }]
  });
  const cleanupLockFile = path.join(dir, 'cleanup-watch.lock');
  writeJson(cleanupLockFile, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: 'cleanup-queue'
  });
  const proofDir = path.join(dir, 'proofs');
  const marker = 'TRAECN_GLM52_CLEAN_MD';
  const finalFile = path.join(proofDir, `${marker}.final.json`);
  writeJson(finalFile, {
    status: 'done',
    marker,
    taskId: 'task_md',
    result: { text: CLEAN_LONG_QUEUE_RESULT_TOKEN }
  });
  setMtime(finalFile, Date.now());

  const report = await collectReport({
    activeQueuePath,
    proofDir,
    cleanupLockFile,
    gatewayProbeFn: async () => ({
      reachable: true,
      host: '127.0.0.1',
      port: 8788,
      elapsedMs: 2,
      status: 200,
      ready: true
    })
  });

  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes('# Unattended Status Report'));
  assert.ok(markdown.includes('## Active Queue'));
  assert.ok(markdown.includes('task_md'));
  assert.ok(markdown.includes('## Cleanup Watcher'));
  assert.ok(markdown.includes('Running: true'));
  assert.ok(markdown.includes('## Long Queue Proof'));
  assert.ok(markdown.includes(marker));
  assert.ok(markdown.includes(`Clean long queue result seen: true`));
  assert.ok(markdown.includes('## Gateway'));
  assert.ok(markdown.includes('Reachable: true'));
});

test('renderMarkdown shows gateway failure section when unreachable', async () => {
  const dir = tempDir();
  const report = await collectReport({
    activeQueuePath: path.join(dir, 'active-queue.json'),
    proofDir: dir,
    cleanupLockFile: path.join(dir, 'cleanup-watch.lock'),
    gatewayProbeFn: async () => ({
      reachable: false,
      host: '127.0.0.1',
      port: 8788,
      elapsedMs: 1,
      status: null,
      error: 'connect ECONNREFUSED 127.0.0.1:8788'
    })
  });
  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes('## Gateway'));
  assert.ok(markdown.includes('Reachable: false'));
  assert.ok(markdown.includes('ECONNREFUSED'));
});

test('collectReport never sends task content or creates conversations', async () => {
  const dir = tempDir();
  let probeCalls = [];
  const gatewayProbeFn = async (opts) => {
    probeCalls.push(opts);
    return { reachable: false, host: opts.host, port: opts.port, elapsedMs: 0, status: null, error: 'mocked' };
  };
  const report = await collectReport({
    activeQueuePath: path.join(dir, 'active-queue.json'),
    proofDir: dir,
    cleanupLockFile: path.join(dir, 'cleanup-watch.lock'),
    gatewayProbeFn
  });
  assert.strictEqual(probeCalls.length, 1);
  assert.strictEqual(report.gateway.reachable, false);
  assert.strictEqual(report.activeQueue.present, false);
});

(async () => {
  console.log('\n[unattended-status-report.test.js] Running tests...\n');
  let passed = 0;
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`  PASS: ${entry.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL: ${entry.name}`);
      console.error(`        ${err.stack || err.message}`);
    }
  }
  console.log(`\n[unattended-status-report.test.js] Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
})();
