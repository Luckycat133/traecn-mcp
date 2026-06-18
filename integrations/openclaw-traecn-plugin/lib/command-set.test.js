'use strict';

const assert = require('assert');
const { executeCommand, listCommands } = require('./command-set');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

(async () => {
  console.log('\n[command-set.test.js] Running command set tests...\n');

  await test('wait_task is exposed for token-efficient queued task waits', async () => {
    const commands = listCommands();
    const wait = commands.find(command => command.command === 'wait_task');
    assert.ok(wait);
    assert.deepStrictEqual(wait.required, ['taskId']);
    assert.ok(wait.optional.includes('pollMs'));
    assert.ok(wait.optional.includes('timeoutMs'));
  });

  await test('wait_task delegates to client waitForTask', async () => {
    let captured = null;
    const client = {
      waitForTask: async (taskId, options) => {
        captured = { taskId, options };
        return { taskId, status: 'done' };
      }
    };
    const result = await executeCommand(client, 'wait_task', {
      taskId: 'task_wait',
      pollMs: 1,
      timeoutMs: 5
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.data.status, 'done');
    assert.strictEqual(captured.taskId, 'task_wait');
    assert.strictEqual(captured.options.pollMs, 1);
    assert.strictEqual(captured.options.timeoutMs, 5);
  });

  await test('review_code forwards completion checks for queued reviews', async () => {
    let captured = null;
    const client = {
      delegateAsync: async (task, options) => {
        captured = { task, options };
        return { status: 202, data: { taskId: 'task_review', status: 'queued' } };
      }
    };
    const completionChecks = {
      requiredFiles: ['FINAL_REPORT.md'],
      requiredText: [{ filePath: 'WORKFLOW_STATUS.md', includes: 'Follow-up 1' }]
    };

    await executeCommand(client, 'review_code', {
      instruction: 'Review and then verify deliverables',
      queue: true,
      completionChecks
    });

    assert.ok(captured.task.includes('Review and then verify deliverables'));
    assert.deepStrictEqual(captured.options.completionChecks, completionChecks);
  });

  await test('review_code forwards completion checks for synchronous reviews', async () => {
    let captured = null;
    const client = {
      delegate: async (task, options) => {
        captured = { task, options };
        return { status: 'done', text: 'ok' };
      }
    };
    const completionChecks = { requiredFiles: ['review.md'] };

    await executeCommand(client, 'review_code', {
      instruction: 'Review with required artifact',
      completionChecks
    });

    assert.ok(captured.task.includes('Review with required artifact'));
    assert.deepStrictEqual(captured.options.completionChecks, completionChecks);
  });

  console.log(`\n[command-set.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('[command-set.test.js] Fatal error:', err);
  process.exit(1);
});
