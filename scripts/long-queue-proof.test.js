'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  acquireProofLock,
  assertClean,
  buildTask,
  cancelProof,
  extractTaskIdFromEvidence,
  findProofScreens,
  isCleanupWatcherScreen,
  isProofLockActive,
  isProofProcessCommand,
  listProofArtifacts,
  listProofProcesses,
  proofLockEvidencePayload,
  quotaApprovalRequiredReport,
  readProofLock,
  releaseProofLock,
  requestWithRetry,
  requiresQuotaSpendApproval,
  resolveExistingSubmission,
  statusReport
} = require('./long-queue-proof');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-long-queue-proof-test-'));
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

function makeProofReadinessRequest(cleanupResponses, calls = []) {
  return async (_options, method, route, body) => {
    calls.push({ method, route, body });
    if (route === '/api/solo/chats/cleanup-foreign-queue') {
      if (body && body.execute) return { ok: true, status: 200, data: { matched: 1, remainingMatched: 0, deleted: 1, stopped: 1 } };
      return cleanupResponses.shift() || { ok: true, status: 200, data: { matched: 0, remainingMatched: 0 } };
    }
    if (route === '/api/queue/status') return { ok: true, status: 200, data: { tasks: [] } };
    if (route === '/api/preflight') return { ok: true, status: 200, data: { ready: true } };
    throw new Error(`unexpected request ${method} ${route}`);
  };
}

test('buildTask creates owned proof text without accidental queue-probe title', () => {
  const task = buildTask('TRAECN_GLM52_CLEAN_TEST', 'GLM-5.2');
  assert.ok(task.includes('TRAECN_GLM52_CLEAN_TEST'));
  assert.ok(task.includes('GLM-5.2'));
  assert.ok(task.includes('clean_long_queue_result'));
  assert.ok(!/Wait for Trae Queue|wait for Trae queue/i.test(task));
});

test('extractTaskIdFromEvidence prefers final report task id then recent events', () => {
  assert.strictEqual(
    extractTaskIdFromEvidence({ taskId: 'task_final' }, [{ taskId: 'task_event' }]),
    'task_final'
  );
  assert.strictEqual(
    extractTaskIdFromEvidence(null, [{ data: { task: { taskId: 'task_nested' } } }]),
    'task_nested'
  );
  assert.strictEqual(extractTaskIdFromEvidence(null, []), null);
});

test('statusReport discovers newest proof files and reports task id', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_STATUS';
  writeJson(path.join(dir, `${marker}.final.json`), {
    status: 'done',
    taskId: 'task_status_report',
    result: { status: 'done' }
  });
  writeJsonl(path.join(dir, `${marker}.jsonl`), [
    { type: 'submit', data: { taskId: 'task_from_submit' } },
    { type: 'task_status', data: { status: 'done' } }
  ]);

  const report = statusReport({ marker: null, outputDir: dir });
  assert.strictEqual(report.status, 'done');
  assert.strictEqual(report.marker, marker);
  assert.strictEqual(report.taskId, 'task_status_report');
  assert.ok(report.files.finalFile.endsWith(`${marker}.final.json`));
  assert.ok(report.recentEvents.length >= 2);
});

test('statusReport discovers lock-only proof runs before evidence exists', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_LOCK_ONLY';
  const lockFile = path.join(dir, `${marker}.lock.json`);
  writeJson(lockFile, {
    marker,
    pid: process.pid,
    role: 'child',
    startedAt: new Date().toISOString()
  });

  const report = statusReport({ marker: null, outputDir: dir });
  assert.strictEqual(report.status, 'locked');
  assert.strictEqual(report.marker, marker);
  assert.strictEqual(report.files.lockFile, lockFile);
  assert.strictEqual(report.lock.active, true);
  assert.strictEqual(report.lock.data.role, 'child');
});

test('statusReport reports stale lock-only proof runs explicitly', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_STALE_LOCK';
  const lockFile = path.join(dir, `${marker}.lock.json`);
  writeJson(lockFile, {
    marker,
    pid: 99999999,
    role: 'foreground',
    startedAt: '2020-01-01T00:00:00.000Z'
  });

  const report = statusReport({ marker: null, outputDir: dir });
  assert.strictEqual(report.status, 'stale_lock');
  assert.strictEqual(report.marker, marker);
  assert.strictEqual(report.lock.active, false);
  assert.strictEqual(report.lock.data.pid, 99999999);
});

test('statusReport chooses the newest proof artifact across final logs and locks', () => {
  const dir = tempDir();
  const oldMarker = 'TRAECN_GLM52_CLEAN_OLD_FINAL';
  const newMarker = 'TRAECN_GLM52_CLEAN_NEW_LOCK';
  const oldFinal = path.join(dir, `${oldMarker}.final.json`);
  const newLock = path.join(dir, `${newMarker}.lock.json`);
  writeJson(oldFinal, {
    status: 'done',
    marker: oldMarker,
    taskId: 'task_old_final'
  });
  writeJson(newLock, {
    marker: newMarker,
    pid: process.pid,
    role: 'child',
    startedAt: new Date().toISOString()
  });
  setMtime(oldFinal, Date.now() - 60000);
  setMtime(newLock, Date.now());

  const artifacts = listProofArtifacts(dir);
  assert.strictEqual(artifacts[0].marker, newMarker);
  assert.strictEqual(artifacts[0].type, 'lock');

  const report = statusReport({ marker: null, outputDir: dir });
  assert.strictEqual(report.status, 'locked');
  assert.strictEqual(report.marker, newMarker);
  assert.strictEqual(report.lock.active, true);
});

test('statusReport still chooses a newer final report over older evidence logs', () => {
  const dir = tempDir();
  const oldMarker = 'TRAECN_GLM52_CLEAN_OLD_LOG';
  const newMarker = 'TRAECN_GLM52_CLEAN_NEW_FINAL';
  const oldLog = path.join(dir, `${oldMarker}.jsonl`);
  const newFinal = path.join(dir, `${newMarker}.final.json`);
  writeJsonl(oldLog, [
    { type: 'submit', data: { taskId: 'task_old_log' } }
  ]);
  writeJson(newFinal, {
    status: 'done',
    marker: newMarker,
    taskId: 'task_new_final'
  });
  setMtime(oldLog, Date.now() - 60000);
  setMtime(newFinal, Date.now());

  const report = statusReport({ marker: null, outputDir: dir });
  assert.strictEqual(report.status, 'done');
  assert.strictEqual(report.marker, newMarker);
  assert.strictEqual(report.taskId, 'task_new_final');
});

test('cancelProof clears a lock-only proof run discovered by default status', async () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_LOCK_CANCEL';
  const lockFile = path.join(dir, `${marker}.lock.json`);
  writeJson(lockFile, {
    marker,
    pid: process.pid,
    role: 'child',
    startedAt: new Date().toISOString()
  });

  const result = await cancelProof({
    marker: null,
    outputDir: dir,
    evidenceLog: null,
    finalFile: null,
    stdoutFile: null,
    stderrFile: null,
    host: '127.0.0.1',
    port: 9,
    token: '',
    resumeTaskId: null
  });

  assert.strictEqual(result.marker, marker);
  assert.strictEqual(result.lockResult.released, true);
  assert.strictEqual(fs.existsSync(lockFile), false);
  assert.ok(fs.existsSync(result.files.finalFile));
});

test('cancelProof clears a stale lock-only proof run discovered by default status', async () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_STALE_LOCK_CANCEL';
  const lockFile = path.join(dir, `${marker}.lock.json`);
  writeJson(lockFile, {
    marker,
    pid: 99999999,
    role: 'foreground',
    startedAt: '2020-01-01T00:00:00.000Z'
  });

  const result = await cancelProof({
    marker: null,
    outputDir: dir,
    evidenceLog: null,
    finalFile: null,
    stdoutFile: null,
    stderrFile: null,
    host: '127.0.0.1',
    port: 9,
    token: '',
    resumeTaskId: null
  });

  assert.strictEqual(result.marker, marker);
  assert.strictEqual(result.previousStatus.status, 'stale_lock');
  assert.strictEqual(result.lockResult.released, true);
  assert.strictEqual(fs.existsSync(lockFile), false);
});

test('isCleanupWatcherScreen recognizes generated cleanup watcher screen names', () => {
  assert.strictEqual(isCleanupWatcherScreen('82435.traecn_cleanup_queue_1781959635765\t(Detached)'), true);
  assert.strictEqual(isCleanupWatcherScreen('59320.traecn_cleanup_queue_long\t(Detached)'), true);
  assert.strictEqual(isCleanupWatcherScreen('82435.traecn_glm52_proof_abc\t(Detached)'), false);
});

test('findProofScreens matches only proof screens for the requested marker', () => {
  const sessions = [
    '101.traecn_glm52_proof_TRAECN_GLM52_CLEAN_A\t(Detached)',
    '102.traecn_glm52_proof_TRAECN_GLM52_CLEAN_B\t(Detached)',
    '103.traecn_cleanup_queue_123\t(Detached)'
  ];
  assert.deepStrictEqual(findProofScreens(sessions, 'TRAECN_GLM52_CLEAN_A'), [sessions[0]]);
  assert.deepStrictEqual(findProofScreens(sessions, null), [sessions[0], sessions[1]]);
});

test('listProofProcesses returns an array for process-level orphan detection', () => {
  const processes = listProofProcesses('TRAECN_GLM52_CLEAN_TEST');
  assert.ok(Array.isArray(processes));
});

test('isProofProcessCommand matches real proof commands without matching node -e probes', () => {
  assert.strictEqual(
    isProofProcessCommand('/Users/tester/.nvm/versions/node/v24.13.1/bin/node /Users/Shared/projects/TRAECNclaw/scripts/long-queue-proof.js --execute --child --marker TRAECN_GLM52_CLEAN_A', 'TRAECN_GLM52_CLEAN_A'),
    true
  );
  assert.strictEqual(
    isProofProcessCommand('node scripts/long-queue-proof.js --execute --detach --marker TRAECN_GLM52_CLEAN_A', 'TRAECN_GLM52_CLEAN_A'),
    true
  );
  assert.strictEqual(
    isProofProcessCommand('/Users/tester/.nvm/versions/node/v24.13.1/bin/node -e "setTimeout(()=>{},120000)" scripts/long-queue-proof.js --execute --marker TRAECN_GLM52_CLEAN_A', 'TRAECN_GLM52_CLEAN_A'),
    false
  );
  assert.strictEqual(
    isProofProcessCommand('node scripts/long-queue-proof.js --status --marker TRAECN_GLM52_CLEAN_A', 'TRAECN_GLM52_CLEAN_A'),
    false
  );
});

test('statusReport recovers task id from full evidence log beyond recent tail', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_LONG_LOG';
  const evidenceLog = path.join(dir, `${marker}.jsonl`);
  writeJsonl(evidenceLog, [
    { type: 'submit', data: { taskId: 'task_long_log' } },
    ...Array.from({ length: 30 }, (_, index) => ({ type: 'task_status', data: { status: 'executing', index } }))
  ]);

  const report = statusReport({
    marker,
    outputDir: dir,
    evidenceLog,
    finalFile: path.join(dir, `${marker}.final.json`),
    stdoutFile: path.join(dir, `${marker}.final.json.stdout.log`),
    stderrFile: path.join(dir, `${marker}.stderr.log`)
  });

  assert.strictEqual(report.status, 'running_or_incomplete');
  assert.strictEqual(report.taskId, 'task_long_log');
  assert.strictEqual(report.eventCount, 31);
  assert.strictEqual(report.recentEvents.length, 12);
});

test('resolveExistingSubmission resumes existing task unless force-new is set', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_RESUME';
  const evidenceLog = path.join(dir, `${marker}.jsonl`);
  const options = {
    marker,
    outputDir: dir,
    evidenceLog,
    finalFile: path.join(dir, `${marker}.final.json`),
    stdoutFile: path.join(dir, `${marker}.final.json.stdout.log`),
    stderrFile: path.join(dir, `${marker}.stderr.log`),
    forceNew: false
  };
  writeJsonl(evidenceLog, [
    { type: 'submit', data: { taskId: 'task_resume_existing' } },
    { type: 'task_status', data: { status: 'executing' } }
  ]);

  const resume = resolveExistingSubmission(options);
  assert.strictEqual(resume.action, 'resume');
  assert.strictEqual(resume.taskId, 'task_resume_existing');

  const forceNew = resolveExistingSubmission({ ...options, forceNew: true });
  assert.strictEqual(forceNew.action, 'submit');
});

test('proof lock prevents duplicate starts for an active marker', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_LOCK_ACTIVE';
  const options = {
    marker,
    outputDir: dir,
    evidenceLog: path.join(dir, `${marker}.jsonl`),
    finalFile: path.join(dir, `${marker}.final.json`),
    stdoutFile: path.join(dir, `${marker}.final.json.stdout.log`),
    stderrFile: path.join(dir, `${marker}.stderr.log`),
    forceNew: false
  };

  const first = acquireProofLock(options, 'foreground');
  assert.strictEqual(first.acquired, true);
  assert.strictEqual(readProofLock(first.lockFile).marker, marker);

  const second = acquireProofLock(options, 'foreground');
  assert.strictEqual(second.acquired, false);
  assert.strictEqual(second.reason, 'proof_lock_active');

  const released = releaseProofLock(first.lockFile, first.lock);
  assert.strictEqual(released.released, true);
});

test('proof lock replaces stale locks when no pid or proof process is active', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_LOCK_STALE';
  const lockFile = path.join(dir, `${marker}.lock.json`);
  const options = {
    marker,
    outputDir: dir,
    lockFile,
    evidenceLog: path.join(dir, `${marker}.jsonl`),
    finalFile: path.join(dir, `${marker}.final.json`),
    stdoutFile: path.join(dir, `${marker}.final.json.stdout.log`),
    stderrFile: path.join(dir, `${marker}.stderr.log`),
    forceNew: false
  };
  writeJson(lockFile, {
    marker,
    pid: 99999999,
    role: 'foreground',
    startedAt: '2020-01-01T00:00:00.000Z'
  });

  assert.strictEqual(isProofLockActive(readProofLock(lockFile), marker), false);
  const acquired = acquireProofLock(options, 'foreground');
  assert.strictEqual(acquired.acquired, true);
  assert.strictEqual(acquired.replaced.pid, 99999999);
  assert.strictEqual(readProofLock(lockFile).pid, process.pid);

  releaseProofLock(acquired.lockFile, acquired.lock);
});

test('proof lock evidence records replaced stale lock details compactly', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_LOCK_EVIDENCE';
  const lockFile = path.join(dir, `${marker}.lock.json`);
  const options = {
    marker,
    outputDir: dir,
    lockFile,
    evidenceLog: path.join(dir, `${marker}.jsonl`),
    finalFile: path.join(dir, `${marker}.final.json`),
    stdoutFile: path.join(dir, `${marker}.final.json.stdout.log`),
    stderrFile: path.join(dir, `${marker}.stderr.log`),
    forceNew: false
  };
  writeJson(lockFile, {
    marker,
    pid: 99999999,
    role: 'foreground',
    startedAt: '2020-01-01T00:00:00.000Z',
    command: 'very long previous command that should not be copied into evidence'
  });

  const acquired = acquireProofLock(options, 'foreground');
  const event = proofLockEvidencePayload(acquired, 'foreground');

  assert.strictEqual(event.type, 'proof_lock_acquired');
  assert.strictEqual(event.replaced, true);
  assert.strictEqual(event.replacedLock.pid, 99999999);
  assert.strictEqual(event.replacedLock.role, 'foreground');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(event.replacedLock, 'command'), false);

  releaseProofLock(acquired.lockFile, acquired.lock);
});

test('proof child can take over detached parent placeholder lock', () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_LOCK_CHILD';
  const options = {
    marker,
    outputDir: dir,
    evidenceLog: path.join(dir, `${marker}.jsonl`),
    finalFile: path.join(dir, `${marker}.final.json`),
    stdoutFile: path.join(dir, `${marker}.final.json.stdout.log`),
    stderrFile: path.join(dir, `${marker}.stderr.log`),
    forceNew: false
  };

  const parent = acquireProofLock(options, 'detached_parent');
  assert.strictEqual(parent.acquired, true);

  const child = acquireProofLock(options, 'child', { takeoverDetachedParent: true });
  assert.strictEqual(child.acquired, true);
  assert.strictEqual(child.replaced.role, 'detached_parent');
  assert.strictEqual(readProofLock(child.lockFile).role, 'child');

  releaseProofLock(child.lockFile, child.lock);
});

test('assertClean auto-cleans queue probes during execute mode before proof submission', async () => {
  const calls = [];
  const evidence = [];
  const readiness = await assertClean({
    execute: true,
    cleanupStabilizeChecks: 3,
    cleanupStabilizeDelayMs: 0,
    requestFn: makeProofReadinessRequest([
      { ok: true, status: 200, data: { matched: 1, remainingMatched: 1 } },
      { ok: true, status: 200, data: { matched: 0, remainingMatched: 0 } }
    ], calls)
  }, evidence);

  assert.strictEqual(readiness.cleanup.matched, 0);
  assert.ok(calls.some(call => call.route === '/api/solo/chats/cleanup-foreign-queue' && call.body?.execute === true));
  assert.ok(evidence.some(event => event.type === 'cleanup_execute'));
  assert.ok(evidence.some(event => event.type === 'preflight'));
});

test('requestWithRetry retries transient gateway failures and records evidence', async () => {
  const evidence = [];
  const calls = [];
  const response = await requestWithRetry({
    execute: true,
    gatewayRetryAttempts: 3,
    gatewayRetryDelayMs: 0,
    requestFn: async (_options, method, route, body) => {
      calls.push({ method, route, body });
      if (calls.length === 1) return { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8788' };
      return { ok: true, status: 200, data: { ready: true } };
    }
  }, 'POST', '/api/preflight', {}, 120000, evidence, 'preflight');

  assert.strictEqual(response.ok, true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(evidence.length, 1);
  assert.strictEqual(evidence[0].type, 'gateway_transient_retry');
  assert.strictEqual(evidence[0].context, 'preflight');
  assert.strictEqual(evidence[0].attempt, 1);
});

test('assertClean survives transient cleanup dry-run gateway restart', async () => {
  const evidence = [];
  const calls = [];
  let cleanupCalls = 0;
  const readiness = await assertClean({
    execute: true,
    gatewayRetryAttempts: 3,
    gatewayRetryDelayMs: 0,
    cleanupStabilizeChecks: 1,
    cleanupStabilizeDelayMs: 0,
    requestFn: async (_options, method, route, body) => {
      calls.push({ method, route, body });
      if (route === '/api/solo/chats/cleanup-foreign-queue' && body?.dryRun === true) {
        cleanupCalls += 1;
        if (cleanupCalls === 1) return { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8788' };
        return { ok: true, status: 200, data: { matched: 0, remainingMatched: 0 } };
      }
      if (route === '/api/queue/status') return { ok: true, status: 200, data: { tasks: [] } };
      if (route === '/api/preflight') return { ok: true, status: 200, data: { ready: true } };
      throw new Error(`unexpected request ${method} ${route}`);
    }
  }, evidence);

  assert.strictEqual(readiness.cleanup.matched, 0);
  assert.ok(calls.length >= 4);
  assert.ok(evidence.some(event => event.type === 'gateway_transient_retry' && event.context === 'cleanup_dry_run'));
  assert.ok(evidence.some(event => event.type === 'cleanup_dry_run' && event.status === 200));
});

test('assertClean requires consecutive clean dry-runs before proof submission', async () => {
  const calls = [];
  const evidence = [];
  const readiness = await assertClean({
    execute: true,
    cleanupStabilizeChecks: 2,
    cleanupStabilizeDelayMs: 0,
    cleanupMaxAttempts: 5,
    requestFn: makeProofReadinessRequest([
      { ok: true, status: 200, data: { matched: 0, remainingMatched: 0 } },
      { ok: true, status: 200, data: { matched: 1, remainingMatched: 1 } },
      { ok: true, status: 200, data: { matched: 0, remainingMatched: 0 } },
      { ok: true, status: 200, data: { matched: 0, remainingMatched: 0 } }
    ], calls)
  }, evidence);

  const dryRuns = evidence.filter(event => event.type === 'cleanup_dry_run');
  assert.strictEqual(readiness.cleanup.matched, 0);
  assert.strictEqual(dryRuns.length, 4);
  assert.deepStrictEqual(dryRuns.map(event => event.cleanStreak), [1, 0, 1, 2]);
  assert.ok(evidence.some(event => event.type === 'cleanup_execute'));
});

test('assertClean keeps dry-run mode read-only when queue probes remain', async () => {
  const calls = [];
  const evidence = [];
  await assert.rejects(
    () => assertClean({
      execute: false,
      cleanupStabilizeDelayMs: 0,
      requestFn: makeProofReadinessRequest([
        { ok: true, status: 200, data: { matched: 1, remainingMatched: 1 } }
      ], calls)
    }, evidence),
    /refusing to start proof/
  );

  assert.ok(!calls.some(call => call.body?.execute === true));
  assert.ok(evidence.some(event => event.type === 'cleanup_dry_run'));
});

test('requiresQuotaSpendApproval blocks only new execute submissions without approval', () => {
  assert.strictEqual(requiresQuotaSpendApproval({
    execute: true,
    allowQuotaSpend: false,
    resumeTaskId: null
  }, { action: 'submit' }), true);
  assert.strictEqual(requiresQuotaSpendApproval({
    execute: true,
    allowQuotaSpend: true,
    resumeTaskId: null
  }, { action: 'submit' }), false);
  assert.strictEqual(requiresQuotaSpendApproval({
    execute: true,
    allowQuotaSpend: false,
    resumeTaskId: 'task_existing'
  }, { action: 'submit' }), false);
  assert.strictEqual(requiresQuotaSpendApproval({
    execute: true,
    allowQuotaSpend: false,
    resumeTaskId: null
  }, { action: 'resume', taskId: 'task_existing' }), false);
  assert.strictEqual(requiresQuotaSpendApproval({
    execute: false,
    allowQuotaSpend: false,
    resumeTaskId: null
  }, { action: 'submit' }), false);
});

test('quotaApprovalRequiredReport tells agents how to avoid accidental quota spend', () => {
  const report = quotaApprovalRequiredReport({
    marker: 'TRAECN_GLM52_CLEAN_QUOTA',
    model: 'GLM-5.2',
    execute: true,
    allowQuotaSpend: false,
    evidenceLog: '/tmp/proof.jsonl',
    finalFile: '/tmp/proof.final.json'
  }, { action: 'submit' });

  assert.strictEqual(report.status, 'quota_approval_required');
  assert.strictEqual(report.quotaApprovalFlag, '--allow-quota-spend');
  assert.ok(report.message.includes('--allow-quota-spend'));
  assert.ok(report.message.includes('--resume-task'));
});

test('dry-run command hints include quota approval to prevent retry loops', () => {
  const source = fs.readFileSync(path.join(__dirname, 'long-queue-proof.js'), 'utf8');
  assert.match(source, /nextCommand:\s*`node scripts\/long-queue-proof\.js --execute --detach \$\{QUOTA_APPROVAL_FLAG\}/);
  assert.match(source, /quotaApprovalCommand:\s*`node scripts\/long-queue-proof\.js --execute --detach \$\{QUOTA_APPROVAL_FLAG\}/);
  assert.ok(!source.includes('nextCommandWithExplicitQuotaApproval'));
});

test('cancelProof writes auditable result when no active task is known', async () => {
  const dir = tempDir();
  const marker = 'TRAECN_GLM52_CLEAN_CANCEL';
  const finalFile = path.join(dir, `${marker}.final.json`);
  const evidenceLog = path.join(dir, `${marker}.jsonl`);
  const result = await cancelProof({
    marker,
    outputDir: dir,
    evidenceLog,
    finalFile,
    stdoutFile: `${finalFile}.stdout.log`,
    stderrFile: path.join(dir, `${marker}.stderr.log`),
    host: '127.0.0.1',
    port: 9,
    token: '',
    resumeTaskId: null
  });

  assert.strictEqual(result.status, 'cancel_requested');
  assert.strictEqual(result.marker, marker);
  assert.strictEqual(result.taskId, null);
  assert.ok(fs.existsSync(finalFile));
  assert.ok(fs.readFileSync(evidenceLog, 'utf8').includes('cancel_screens'));
  assert.ok(fs.readFileSync(evidenceLog, 'utf8').includes('cancel_processes'));
  assert.ok(fs.readFileSync(evidenceLog, 'utf8').includes('cancel_lock'));
});

(async () => {
  console.log('\n[long-queue-proof.test.js] Running tests...\n');
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
  console.log(`\n[long-queue-proof.test.js] Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
})();
