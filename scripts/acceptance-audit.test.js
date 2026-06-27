'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  proofEvidenceSummary,
  scoreProofReports,
  scoreRealLongQueue
} = require('./acceptance-audit');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-acceptance-audit-test-'));
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.map(value => JSON.stringify(value)).join('\n') + '\n');
}

function cleanReport(dir, marker = 'TRAECN_GLM52_CLEAN_AUDIT_1781956000000') {
  const evidenceLog = path.join(dir, `${marker}.jsonl`);
  return {
    status: 'done',
    marker,
    model: 'GLM-5.2',
    taskId: 'task_clean_audit',
    evidenceLog,
    result: {
      status: 'done',
      wait: { attempts: 4, elapsedMs: 1800000 },
      queueDetails: { queued: true, queuePosition: 42 },
      text: JSON.stringify({ token: marker, model: 'GLM-5.2', status: 'clean_long_queue_result' })
    },
    path: path.join(dir, `${marker}.final.json`)
  };
}

test('proofEvidenceSummary verifies required proof events', () => {
  const dir = tempDir();
  const report = cleanReport(dir);
  writeJsonl(report.evidenceLog, [
    { type: 'cleanup_dry_run', data: { matched: 0, remainingMatched: 0 } },
    { type: 'queue_status', data: { tasks: [] } },
    { type: 'preflight', data: { ready: true, queue: { queued: true, queuePosition: 42, message: '排在第 42 位' } } },
    { type: 'switch_model', data: { success: true, model: 'GLM-5.2' } },
    { type: 'submit', data: { taskId: report.taskId } },
    { type: 'task_status', data: { status: 'done', queueDetails: { queued: false } } }
  ]);

  const summary = proofEvidenceSummary(report);
  assert.strictEqual(summary.parseErrors, 0);
  assert.strictEqual(summary.cleanCleanup, true);
  assert.strictEqual(summary.hasPreflight, true);
  assert.strictEqual(summary.hasSwitchModel, true);
  assert.strictEqual(summary.hasSubmit, true);
  assert.strictEqual(summary.submittedTaskId, report.taskId);
  assert.strictEqual(summary.doneTaskStatus, true);
  assert.strictEqual(summary.queueLifecycle, true);
});

test('scoreProofReports rejects a final report without evidence log', () => {
  const dir = tempDir();
  const report = cleanReport(dir);
  const score = scoreProofReports([report]);
  assert.strictEqual(score, null);
});

test('scoreProofReports rejects mismatched submitted task id', () => {
  const dir = tempDir();
  const report = cleanReport(dir);
  writeJsonl(report.evidenceLog, [
    { type: 'cleanup_dry_run', data: { matched: 0, remainingMatched: 0 } },
    { type: 'preflight', data: { ready: true, queue: { queued: true, queuePosition: 5 } } },
    { type: 'switch_model', data: { success: true, model: 'GLM-5.2' } },
    { type: 'submit', data: { taskId: 'task_other' } },
    { type: 'task_status', data: { status: 'done' } }
  ]);
  const score = scoreProofReports([report]);
  assert.strictEqual(score, null);
});

test('scoreProofReports accepts completed clean GLM-5.2 proof with evidence', () => {
  const dir = tempDir();
  const report = cleanReport(dir);
  writeJsonl(report.evidenceLog, [
    { type: 'cleanup_dry_run', data: { matched: 0, remainingMatched: 0 } },
    { type: 'queue_status', data: { tasks: [] } },
    { type: 'preflight', data: { ready: true, queue: { queued: true, queuePosition: 42, message: '排在第 42 位' } } },
    { type: 'switch_model', data: { success: true, model: 'GLM-5.2' } },
    { type: 'submit', data: { taskId: report.taskId } },
    { type: 'task_status', data: { status: 'executing', queueDetails: { queued: true, queuePosition: 42 } } },
    { type: 'task_status', data: { status: 'done', queueDetails: { queued: false } } },
    { type: 'wait_cleanup_dry_run', data: { matched: 0, remainingMatched: 0 } }
  ]);

  const score = scoreProofReports([report]);
  assert.strictEqual(score.status, 'passed');
  assert.strictEqual(score.evidence[0].taskId, report.taskId);
  assert.strictEqual(score.evidence[0].evidence.doneTaskStatus, true);
});

test('scoreRealLongQueue accepts clean final recovery despite historical queue contamination', () => {
  const marker = 'TRAECN_GLM52_MEANINGFUL_STATUS_REPORT_1782000683181';
  const score = scoreRealLongQueue([{
    taskId: 'task_recovered_clean',
    status: 'completed',
    task: `${marker}\nUse GLM-5.2 for meaningful work`,
    elapsedMs: 2959594,
    metadata: {
      currentModel: 'GLM-5.2',
      queueState: 'queued'
    },
    steps: [
      { action: 'solo_chat_switch', details: { result: { title: 'Wait for Trae Queue 进行中 08:42' } } },
      { action: 'done', success: true }
    ],
    result: {
      text: `任务完成: submitted Solo chat is done and completion checks passed.\n${marker}\nunattended-status-report.js`,
      completionChecksPassed: true,
      activeSoloChat: { title: 'Implement Unattended Status Report Tool 任务完成 08:32', status: 'done' }
    }
  }], []);

  assert.strictEqual(score.status, 'passed');
  assert.strictEqual(score.evidence[0].contaminated, true);
  assert.strictEqual(score.evidence[0].finalResultContaminated, false);
  assert.strictEqual(score.evidence[0].completionChecksPassed, true);
});

test('require-complete exits nonzero when real GLM-5.2 proof is missing', () => {
  const dir = tempDir();
  const activeQueuePath = path.join(dir, 'active-queue.json');
  const taskHistoryPath = path.join(dir, 'task-history.json');
  const proofDir = path.join(dir, 'proofs');
  fs.writeFileSync(activeQueuePath, JSON.stringify({ tasks: [] }));
  fs.writeFileSync(taskHistoryPath, JSON.stringify({ tasks: [] }));
  fs.mkdirSync(proofDir, { recursive: true });

  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'acceptance-audit.js'),
    '--no-live',
    '--require-complete'
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH: activeQueuePath,
      TRAECN_TASK_HISTORY_PERSISTENCE_PATH: taskHistoryPath,
      TRAECN_LONG_QUEUE_PROOF_DIR: proofDir
    }
  });

  assert.notStrictEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.requireComplete, true);
  assert.strictEqual(report.liveChecked, false);
  const isolation = report.results.find(entry => entry.name === 'multi_session_result_isolation');
  assert.strictEqual(isolation.status, 'passed');
  const vibeWorkflow = report.results.find(entry => entry.name === 'unattended_vibe_workflow_contract');
  assert.strictEqual(vibeWorkflow.status, 'passed');
  const settingsControl = report.results.find(entry => entry.name === 'app_settings_control_contract');
  assert.strictEqual(settingsControl.status, 'passed');
  const soloCleanup = report.results.find(entry => entry.name === 'solo_cleanup_full_scan');
  assert.strictEqual(soloCleanup.status, 'passed');
  const longQueue = report.results.find(entry => entry.name === 'real_long_queue_result_retrieval');
  assert.strictEqual(longQueue.status, 'missing');
});

(async () => {
  console.log('\n[acceptance-audit.test.js] Running tests...\n');
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
  console.log(`\n[acceptance-audit.test.js] Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
})();
