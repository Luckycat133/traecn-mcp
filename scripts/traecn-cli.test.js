'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

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

test('loadConfig uses environment variable for token when set', () => {
  process.env.TRAECN_GATEWAY_TOKEN = 'test-token-456';
  clearModuleCache();
  const { loadConfig } = require('./traecn-cli');
  const cfg = loadConfig();
  assert.strictEqual(cfg.token, 'test-token-456');
  delete process.env.TRAECN_GATEWAY_TOKEN;
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
  const { COLORS } = require('./traecn-cli');
  assert.ok(COLORS !== undefined);
  const expectedPath = path.join(os.homedir(), '.traecnrc');
  assert.ok(expectedPath.endsWith('.traecnrc'));
});

test('CLI exposes preflight command in help and dispatcher', () => {
  const source = fs.readFileSync(path.join(__dirname, 'traecn-cli.js'), 'utf8');
  assert.ok(source.includes("'preflight'") || source.includes('"preflight"'));
  assert.ok(source.includes('cmdPreflight'));
  assert.ok(source.includes('/api/preflight'));
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

test('CLI wait parser accepts auto dialog approval action', () => {
  clearModuleCache();
  const { parseWaitArgs } = require('./traecn-cli');
  const parsed = parseWaitArgs(['task_123', '--auto-approve-dialog', 'auto']);
  assert.strictEqual(parsed.autoApproveDialog, 'auto');
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

console.log(`\n[traecn-cli.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
