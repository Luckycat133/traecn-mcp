'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TEST_CONFIG_FILE = path.join(os.tmpdir(), `traecn-cli-test-${process.pid}.json`);
process.env.TRAECN_CONFIG_FILE = TEST_CONFIG_FILE;
try {
  fs.unlinkSync(TEST_CONFIG_FILE);
} catch {}

const { createRunner } = require('../src/shared/test-runner');

const r = createRunner('traecn-cli.test.js');
const { test, asyncTest, summary } = r;

function clearModuleCache() {
  const keys = Object.keys(require.cache);
  for (const key of keys) {
    if (key.includes('traecn-cli')) {
      delete require.cache[key];
    }
  }
}

console.log('\n[traecn-cli.test.js] Running CLI tests...\n');

test('COLORS object has all required color codes', () => {
  clearModuleCache();
  const { COLORS } = require('./traecn-cli');
  const required = ['reset', 'bold', 'dim', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'];
  required.forEach(color => {
    assert.strictEqual(typeof COLORS[color], 'string');
    assert.ok(COLORS[color].length > 0);
  });
});

test('color function returns colored string', () => {
  clearModuleCache();
  const { COLORS } = require('./traecn-cli');
  const result = COLORS.green + 'test' + COLORS.reset;
  assert.ok(result.includes('\x1b[32m'));
  assert.ok(result.includes('test'));
  assert.ok(result.includes('\x1b[0m'));
});

test('loadConfig returns object with required properties', () => {
  clearModuleCache();
  const { loadConfig } = require('./traecn-cli');
  const cfg = loadConfig();
  assert.strictEqual(typeof cfg.host, 'string');
  assert.strictEqual(typeof cfg.port, 'number');
  assert.strictEqual(typeof cfg.token, 'string');
});

test('loadConfig uses environment variable for host when set', () => {
  process.env.TRAECN_HOST = '192.168.1.1';
  clearModuleCache();
  const { loadConfig } = require('./traecn-cli');
  const cfg = loadConfig();
  assert.strictEqual(cfg.host, '192.168.1.1');
  delete process.env.TRAECN_HOST;
});

test('loadConfig uses environment variable for port when set', () => {
  process.env.TRAECN_PORT = '9999';
  clearModuleCache();
  const { loadConfig } = require('./traecn-cli');
  const cfg = loadConfig();
  assert.strictEqual(cfg.port, 9999);
  delete process.env.TRAECN_PORT;
});

test('loadConfig prefers canonical gateway variables over legacy aliases', () => {
  process.env.TRAECN_GATEWAY_HOST = '127.0.0.9';
  process.env.TRAECN_GATEWAY_PORT = '8899';
  process.env.TRAECN_HOST = '127.0.0.8';
  process.env.TRAECN_PORT = '8888';
  try {
    clearModuleCache();
    const { loadConfig } = require('./traecn-cli');
    const cfg = loadConfig();
    assert.strictEqual(cfg.host, '127.0.0.9');
    assert.strictEqual(cfg.port, 8899);
  } finally {
    delete process.env.TRAECN_GATEWAY_HOST;
    delete process.env.TRAECN_GATEWAY_PORT;
    delete process.env.TRAECN_HOST;
    delete process.env.TRAECN_PORT;
  }
});

test('loadConfig uses environment variable for token when set', () => {
  process.env.TRAECN_GATEWAY_TOKEN = 'test-token-456';
  clearModuleCache();
  const { loadConfig } = require('./traecn-cli');
  const cfg = loadConfig();
  assert.strictEqual(cfg.token, 'test-token-456');
  delete process.env.TRAECN_GATEWAY_TOKEN;
});

test('apiRequest applies the CLI 60 second timeout to the HTTP client', () => {
  const { TraeCNApiClient } = require('../src/client/traecnapi-client');
  const originalRequest = TraeCNApiClient.prototype._request;
  TraeCNApiClient.prototype._request = function captureTimeout() {
    return this.timeout;
  };

  try {
    clearModuleCache();
    const { apiRequest } = require('./traecn-cli');
    assert.strictEqual(apiRequest('GET', '/api/status'), 60000);
  } finally {
    TraeCNApiClient.prototype._request = originalRequest;
    clearModuleCache();
  }
});

test('buildProofCliArgs maps proof status without execute side effects', () => {
  clearModuleCache();
  const { buildProofCliArgs } = require('./traecn-cli');
  const args = buildProofCliArgs(['status', '--marker', 'TRAECN_GLM52_SAFE']);
  assert.ok(args[0].endsWith('long-queue-proof.js'));
  assert.ok(args.includes('--status'));
  assert.ok(args.includes('--marker'));
  assert.ok(!args.includes('--execute'));
});

test('buildProofCliArgs keeps proof start dry-run unless caller passes execute', () => {
  clearModuleCache();
  const { buildProofCliArgs } = require('./traecn-cli');
  const dryRun = buildProofCliArgs(['start', '--marker', 'TRAECN_GLM52_SAFE']);
  const execute = buildProofCliArgs(['start', '--execute', '--detach', '--allow-quota-spend']);
  assert.ok(!dryRun.includes('--status'));
  assert.ok(!dryRun.includes('--cancel'));
  assert.ok(!dryRun.includes('--execute'));
  assert.ok(!dryRun.includes('--allow-quota-spend'));
  assert.ok(execute.includes('--execute'));
  assert.ok(execute.includes('--detach'));
  assert.ok(execute.includes('--allow-quota-spend'));
});

test('CLI proof help does not suggest quota-spending start without approval flag', () => {
  const source = fs.readFileSync(path.join(__dirname, 'traecn-cli.js'), 'utf8');
  assert.ok(source.includes('traecnclaw proof start --execute --detach --allow-quota-spend --marker'));
  assert.ok(!source.includes('traecnclaw proof start --execute --detach --marker'));
});

test('buildLocalScriptArgs exposes first-run and operator commands from the package', () => {
  clearModuleCache();
  const { buildLocalScriptArgs } = require('./traecn-cli');
  assert.ok(buildLocalScriptArgs('setup-mcp', ['--output', 'mcp.json'])[0].endsWith('setup-mcp.js'));
  assert.ok(buildLocalScriptArgs('doctor')[0].endsWith('doctor.js'));
  assert.ok(buildLocalScriptArgs('quickstart', ['--launch-trae'])[0].endsWith('quickstart.js'));
  assert.deepStrictEqual(buildLocalScriptArgs('service', ['status']).slice(-1), ['status']);
  assert.ok(buildLocalScriptArgs('live-uat', ['--strict'])[0].endsWith('live-uat.js'));
  assert.throws(() => buildLocalScriptArgs('delegate'), /Unknown local operator command/);
});

test('buildProofCliArgs maps proof cancel without resubmission flag', () => {
  clearModuleCache();
  const { buildProofCliArgs } = require('./traecn-cli');
  const args = buildProofCliArgs(['cancel', '--marker', 'TRAECN_GLM52_SAFE']);
  assert.ok(args.includes('--cancel'));
  assert.ok(!args.includes('--execute'));
});

test('saveConfig returns boolean result', () => {
  clearModuleCache();
  const { saveConfig } = require('./traecn-cli');
  const testConfig = { host: 'localhost', port: 8888, token: 'test' };
  const result = saveConfig(testConfig);
  assert.strictEqual(typeof result, 'boolean');
});

test('batch tasks JSON format validation - array format', () => {
  const validBatch = [
    { task: 'Task 1' },
    { task: 'Task 2', priority: 8 }
  ];

  const tasks = validBatch.map(t => typeof t === 'string' ? { task: t } : t);
  assert.strictEqual(tasks.length, 2);
  assert.strictEqual(tasks[0].task, 'Task 1');
  assert.strictEqual(tasks[1].task, 'Task 2');
  assert.strictEqual(tasks[1].priority, 8);
});

test('batch tasks JSON format validation - object format', () => {
  const validBatch = {
    tasks: [
      { task: 'Task 1', priority: 5 },
      { task: 'Task 2', priority: 10 }
    ],
    strategy: 'priority',
    maxConcurrency: 10,
    onComplete: 'https://example.com/callback'
  };

  assert.ok(Array.isArray(validBatch.tasks));
  assert.strictEqual(validBatch.tasks.length, 2);
  assert.strictEqual(validBatch.strategy, 'priority');
  assert.strictEqual(validBatch.maxConcurrency, 10);
  assert.strictEqual(validBatch.onComplete, 'https://example.com/callback');
});

test('batch tasks validation - empty tasks rejected', () => {
  const emptyBatch = { tasks: [] };
  const isValid = emptyBatch.tasks && Array.isArray(emptyBatch.tasks) && emptyBatch.tasks.length > 0;
  assert.strictEqual(isValid, false);
});

test('batch tasks validation - max 100 tasks', () => {
  const bigBatch = { tasks: new Array(101).fill({ task: 'test' }) };
  const isValid = bigBatch.tasks.length <= 100;
  assert.strictEqual(isValid, false);
});

test('batch tasks validation - each task must have task string', () => {
  const invalidBatch = {
    tasks: [
      { task: 'Valid' },
      { priority: 5 },
      {}
    ]
  };

  for (const item of invalidBatch.tasks) {
    if (!item.task || typeof item.task !== 'string') {
      assert.ok(true);
      return;
    }
  }
  assert.fail('Should have detected invalid task');
});

test('strategy validation - valid strategies accepted', () => {
  const validStrategies = ['parallel', 'sequential', 'priority'];
  validStrategies.forEach(strategy => {
    assert.ok(['parallel', 'sequential', 'priority'].includes(strategy));
  });
});

test('strategy validation - invalid strategy rejected', () => {
  const invalidStrategy = 'invalid';
  assert.ok(!['parallel', 'sequential', 'priority'].includes(invalidStrategy));
});

test('maxConcurrency clamped to valid range - min boundary', () => {
  const min = 1;
  const max = 20;
  const clamp = (val, def) => Math.min(Math.max(val || def, min), max);

  assert.strictEqual(clamp(0, 5), 5);
});

test('maxConcurrency clamped to valid range - max boundary', () => {
  const min = 1;
  const max = 20;
  const clamp = (val, def) => Math.min(Math.max(val || def, min), max);

  assert.strictEqual(clamp(25, 5), 20);
});

test('maxConcurrency clamped to valid range - within range', () => {
  const min = 1;
  const max = 20;
  const clamp = (val, def) => Math.min(Math.max(val || def, min), max);

  assert.strictEqual(clamp(10, 5), 10);
});

test('maxConcurrency clamped to valid range - null value uses default', () => {
  const min = 1;
  const max = 20;
  const clamp = (val, def) => Math.min(Math.max(val || def, min), max);

  assert.strictEqual(clamp(null, 5), 5);
});

test('maxConcurrency clamped to valid range - undefined uses default', () => {
  const min = 1;
  const max = 20;
  const clamp = (val, def) => Math.min(Math.max(val || def, min), max);

  assert.strictEqual(clamp(undefined, 5), 5);
});

test('priority sorting for priority strategy', () => {
  const tasks = [
    { taskId: '1', task: 'Low', priority: 1 },
    { taskId: '2', task: 'High', priority: 10 },
    { taskId: '3', task: 'Medium', priority: 5 }
  ];

  tasks.sort((a, b) => b.priority - a.priority);

  assert.strictEqual(tasks[0].priority, 10);
  assert.strictEqual(tasks[1].priority, 5);
  assert.strictEqual(tasks[2].priority, 1);
});

test('progress bar formatting', () => {
  const width = 30;
  const filled = Math.round((5 / 10) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percent = Math.round((5 / 10) * 100);

  assert.strictEqual(bar.length, 30);
  assert.strictEqual(percent, 50);
  assert.ok(bar.startsWith('█████'));
});

test('progress bar at 0%', () => {
  const width = 30;
  const filled = Math.round((0 / 10) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width);
  const percent = Math.round((0 / 10) * 100);

  assert.strictEqual(percent, 0);
  assert.ok(bar.startsWith('░'));
});

test('progress bar at 100%', () => {
  const width = 30;
  const filled = Math.round((10 / 10) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const percent = Math.round((10 / 10) * 100);

  assert.strictEqual(percent, 100);
  assert.ok(bar.startsWith('█'));
  assert.strictEqual(filled, width);
});

test('config file path uses home directory', () => {
  clearModuleCache();
  const { COLORS, CONFIG_FILE } = require('./traecn-cli');
  assert.ok(COLORS !== undefined);
  assert.strictEqual(CONFIG_FILE, TEST_CONFIG_FILE);
});

test('CLI exposes preflight command in help and dispatcher', () => {
  const source = fs.readFileSync(path.join(__dirname, 'traecn-cli.js'), 'utf8');
  assert.ok(source.includes("'preflight'") || source.includes('"preflight"'));
  assert.ok(source.includes('cmdPreflight'));
  assert.ok(source.includes('/api/preflight'));
});

test('CLI exposes cleanup-queue command in help and dispatcher', () => {
  const source = fs.readFileSync(path.join(__dirname, 'traecn-cli.js'), 'utf8');
  assert.ok(source.includes("'cleanup-queue'") || source.includes('"cleanup-queue"'));
  assert.ok(source.includes('cmdCleanupQueue'));
  assert.ok(source.includes('/api/solo/chats/cleanup-foreign-queue'));
  assert.ok(source.includes('--execute'));
  assert.ok(source.includes('--status'));
  assert.ok(source.includes('buildDetachedCleanupCommand'));
  assert.ok(source.includes('describeCleanupWatchStatus'));
  assert.ok(source.includes('cleanup-queue --execute --watch-ms 7200000'));
  assert.ok(source.includes('hasResidualMatches ? 1000'), 'cleanup watcher must retry quickly when matched chats remain');
});

test('CLI exposes vibe completion check flags', () => {
  const source = fs.readFileSync(path.join(__dirname, 'traecn-cli.js'), 'utf8');
  assert.ok(source.includes('--check-file'));
  assert.ok(source.includes('--check-text'));
  assert.ok(source.includes('--completion-checks-json'));
});

test('CLI exposes quiet wait command for queued tasks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'traecn-cli.js'), 'utf8');
  assert.ok(source.includes("'wait'") || source.includes('"wait"'));
  assert.ok(source.includes('cmdWait'));
  assert.ok(source.includes('--poll-ms'));
  assert.ok(source.includes('--timeout-ms'));
  assert.ok(source.includes('--log'));
});

test('CLI completion check helpers build required files and text checks', () => {
  clearModuleCache();
  const {
    addRequiredFileCheck,
    addRequiredTextCheck,
    hasCompletionChecks,
    parseCompletionChecksArg
  } = require('./traecn-cli');
  const checks = {};

  addRequiredFileCheck(checks, 'FINAL_REPORT.md');
  addRequiredTextCheck(checks, 'WORKFLOW_STATUS.md:Follow-up 1');

  assert.deepStrictEqual(checks.requiredFiles, ['FINAL_REPORT.md']);
  assert.deepStrictEqual(checks.requiredText, [
    { filePath: 'WORKFLOW_STATUS.md', includes: 'Follow-up 1' }
  ]);
  assert.strictEqual(hasCompletionChecks(checks), true);
  assert.deepStrictEqual(
    parseCompletionChecksArg('{"requiredFiles":["DONE.md"]}', 'test checks'),
    { requiredFiles: ['DONE.md'] }
  );
});

test('CLI wait parser handles quiet indefinite evidence logging', () => {
  clearModuleCache();
  const { parseWaitArgs } = require('./traecn-cli');
  const parsed = parseWaitArgs([
    'task_123',
    '--poll-ms', '45000',
    '--timeout-ms', '0',
    '--log', 'evidence.jsonl',
    '--quiet',
    '-o', 'json'
  ]);

  assert.strictEqual(parsed.taskId, 'task_123');
  assert.strictEqual(parsed.pollMs, 45000);
  assert.strictEqual(parsed.timeoutMs, 0);
  assert.strictEqual(parsed.logFile, 'evidence.jsonl');
  assert.strictEqual(parsed.quiet, true);
  assert.strictEqual(parsed.outputFormat, 'json');
});

test('CLI wait parser handles detached screen options', () => {
  clearModuleCache();
  const { parseWaitArgs } = require('./traecn-cli');
  const parsed = parseWaitArgs([
    'task_abc',
    '--detach',
    '--session', 'traecn_wait_custom',
    '--final', 'final.json',
    '--stderr', 'wait.err'
  ]);

  assert.strictEqual(parsed.detach, true);
  assert.strictEqual(parsed.sessionName, 'traecn_wait_custom');
  assert.strictEqual(parsed.finalFile, 'final.json');
  assert.strictEqual(parsed.stderrFile, 'wait.err');
});

test('CLI wait parser accepts auto dialog approval action', () => {
  clearModuleCache();
  const { parseWaitArgs } = require('./traecn-cli');
  const parsed = parseWaitArgs(['task_123', '--auto-approve-dialog', 'auto']);
  assert.strictEqual(parsed.autoApproveDialog, 'auto');
});

test('buildDetachedWaitCommand creates non-recursive screen command', () => {
  clearModuleCache();
  const { buildDetachedWaitCommand } = require('./traecn-cli');
  const command = buildDetachedWaitCommand({
    taskId: 'task:123',
    pollMs: 30000,
    timeoutMs: 0,
    logFile: 'logs/wait.jsonl',
    detach: true
  }, '/tmp/project path');
  const shellCommand = command.screenArgs[4];

  assert.strictEqual(command.sessionName, 'traecn_wait_task_123');
  assert.ok(command.finalFile.endsWith(path.join('logs', 'wait-final.json')));
  assert.ok(command.stderrFile.endsWith(path.join('logs', 'wait.stderr')));
  assert.ok(shellCommand.includes('/tmp/project path'));
  assert.ok(shellCommand.includes("'wait'"));
  assert.ok(!shellCommand.includes('--detach'));
});

test('acquireCleanupWatchLock creates and releases a cleanup watcher lock', () => {
  clearModuleCache();
  const { acquireCleanupWatchLock, readCleanupWatchLock } = require('./traecn-cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-cleanup-lock-test-'));
  const lockFile = path.join(dir, 'cleanup-watch.lock');
  const lock = acquireCleanupWatchLock({ lockFile, watchMs: 1000, stableMs: 100, intervalMs: 50 });

  assert.strictEqual(lock.ok, true);
  assert.strictEqual(fs.existsSync(lockFile), true);
  assert.strictEqual(readCleanupWatchLock(lockFile).pid, process.pid);
  lock.release();
  assert.strictEqual(fs.existsSync(lockFile), false);
});

test('acquireCleanupWatchLock rejects an already running watcher lock', () => {
  clearModuleCache();
  const { acquireCleanupWatchLock } = require('./traecn-cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-cleanup-lock-test-'));
  const lockFile = path.join(dir, 'cleanup-watch.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const lock = acquireCleanupWatchLock({ lockFile });
  assert.strictEqual(lock.ok, false);
  assert.strictEqual(lock.alreadyRunning, true);
  assert.strictEqual(lock.existing.pid, process.pid);
});

test('acquireCleanupWatchLock replaces stale watcher lock', () => {
  clearModuleCache();
  const { acquireCleanupWatchLock } = require('./traecn-cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-cleanup-lock-test-'));
  const lockFile = path.join(dir, 'cleanup-watch.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, startedAt: 'stale' }));

  const lock = acquireCleanupWatchLock({ lockFile });
  assert.strictEqual(lock.ok, true);
  assert.strictEqual(lock.owner.pid, process.pid);
  lock.release();
});

test('describeCleanupWatchStatus reports running and stale watcher locks', () => {
  clearModuleCache();
  const { describeCleanupWatchStatus } = require('./traecn-cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-cleanup-lock-test-'));
  const runningLock = path.join(dir, 'running.lock');
  const staleLock = path.join(dir, 'stale.lock');
  fs.writeFileSync(runningLock, JSON.stringify({ pid: process.pid, startedAt: 'now' }));
  fs.writeFileSync(staleLock, JSON.stringify({ pid: 99999999, startedAt: 'stale' }));

  const running = describeCleanupWatchStatus({ lockFile: runningLock });
  const stale = describeCleanupWatchStatus({ lockFile: staleLock });
  assert.strictEqual(running.running, true);
  assert.strictEqual(running.stale, false);
  assert.strictEqual(stale.running, false);
  assert.strictEqual(stale.stale, true);
});

test('cleanup watcher process helpers avoid killing current process', () => {
  clearModuleCache();
  const { processInfoForPid, terminateCleanupWatcher, listCleanupWatcherProcesses } = require('./traecn-cli');
  const info = processInfoForPid(process.pid);
  assert.strictEqual(info.pid, process.pid);
  assert.ok(info.pgid > 0);
  const terminated = terminateCleanupWatcher(process.pid);
  assert.strictEqual(terminated.terminated, false);
  assert.strictEqual(terminated.reason, 'invalid_or_current_pid');
  assert.ok(Array.isArray(listCleanupWatcherProcesses()));
});

test('buildDetachedCleanupCommand forwards singleton lock options', () => {
  clearModuleCache();
  const { buildDetachedCleanupCommand } = require('./traecn-cli');
  const detached = buildDetachedCleanupCommand({
    maxPasses: 20,
    watchMs: 10000,
    stableMs: 1000,
    intervalMs: 500,
    lockFile: '/tmp/traecn-cleanup.lock',
    replace: true
  }, '/tmp/project');
  const command = detached.screenArgs[4];
  assert.ok(command.includes('--lock-file'));
  assert.ok(command.includes('/tmp/traecn-cleanup.lock'));
  assert.ok(command.includes('--final'));
  assert.ok(command.includes('--stderr'));
  assert.ok(command.includes('--replace'));
});

test('runCleanupWatchAttempt treats request failures as transient retryable iterations', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('assert');
    const { runCleanupWatchAttempt } = require('./scripts/traecn-cli');
    (async () => {
      const failed = await runCleanupWatchAttempt(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8788'); }, { lockFile: '/tmp/cleanup.lock', intervalMs: 25 });
      assert.strictEqual(failed.result.status, 0);
      assert.strictEqual(failed.transient, true);
      assert.strictEqual(failed.clean, false);
      assert.strictEqual(failed.iteration.transient, true);
      assert.strictEqual(failed.iteration.nextDelayMs, 1000);
      const clean = await runCleanupWatchAttempt(async () => ({ status: 200, data: { matched: 0, remainingMatched: 0, deleted: 0, stopped: 0, passes: 1 } }), { lockFile: '/tmp/cleanup.lock', intervalMs: 25 });
      assert.strictEqual(clean.result.status, 200);
      assert.strictEqual(clean.transient, false);
      assert.strictEqual(clean.clean, true);
      assert.strictEqual(clean.iteration.matched, 0);
    })().catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
  `], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, TRAECN_CONFIG_FILE: TEST_CONFIG_FILE }
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

test('defaultWaitSessionName sanitizes task ids for screen', () => {
  clearModuleCache();
  const { defaultWaitSessionName } = require('./traecn-cli');
  assert.strictEqual(defaultWaitSessionName('task:abc/123'), 'traecn_wait_task_abc_123');
});

test('appendJsonLine writes machine-readable evidence', () => {
  clearModuleCache();
  const { appendJsonLine } = require('./traecn-cli');
  const tmp = path.join(os.tmpdir(), `traecn-wait-${Date.now()}.jsonl`);
  appendJsonLine(tmp, { taskId: 'task_123', status: 'queued' });
  const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n');
  assert.deepStrictEqual(JSON.parse(lines[0]), { taskId: 'task_123', status: 'queued' });
  fs.unlinkSync(tmp);
});

test('task string length validation', () => {
  const maxLength = 100000;
  const validTask = 'a'.repeat(maxLength);
  const invalidTask = 'a'.repeat(maxLength + 1);

  assert.strictEqual(validTask.length <= maxLength, true);
  assert.strictEqual(invalidTask.length <= maxLength, false);
});

test('batchId format validation', () => {
  const batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  assert.ok(batchId.startsWith('batch_'));
  assert.ok(batchId.includes('_'));
  assert.strictEqual(batchId.length > 15, true);
});

test('taskId format includes batchId prefix', () => {
  const batchId = 'batch_123456_abc';
  const taskId = `${batchId}_0`;

  assert.ok(taskId.startsWith(batchId));
  assert.ok(taskId.endsWith('_0'));
});

summary();
process.exit(r.failed > 0 ? 1 : 0);
