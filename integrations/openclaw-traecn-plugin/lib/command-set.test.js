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

  await test('solo chat commands are exposed for real Solo sidebar control', async () => {
    const commands = listCommands();
    const list = commands.find(command => command.command === 'list_solo_chats');
    const switchChat = commands.find(command => command.command === 'switch_solo_chat');
    const submit = commands.find(command => command.command === 'submit_solo_chat_task');

    assert.ok(list);
    assert.deepStrictEqual(list.required, []);
    assert.ok(switchChat);
    assert.ok(switchChat.optional.includes('index'));
    assert.ok(switchChat.optional.includes('titleIncludes'));
    assert.ok(switchChat.optional.includes('textIncludes'));
    assert.ok(submit);
    assert.deepStrictEqual(submit.required, ['task']);
    assert.ok(submit.optional.includes('soloChat'));
    assert.ok(submit.optional.includes('soloChatTitleIncludes'));
  });

  await test('list_solo_chats delegates to client listSoloChats', async () => {
    let called = false;
    const client = {
      listSoloChats: async () => {
        called = true;
        return { status: 200, data: { mode: 'solo', count: 1 } };
      }
    };

    const result = await executeCommand(client, 'list_solo_chats', {});
    assert.strictEqual(called, true);
    assert.strictEqual(result.data.mode, 'solo');
  });

  await test('switch_solo_chat delegates criteria to client switchSoloChat', async () => {
    let captured = null;
    const client = {
      switchSoloChat: async (criteria) => {
        captured = criteria;
        return { status: 200, data: { success: true, index: 3 } };
      }
    };

    const result = await executeCommand(client, 'switch_solo_chat', {
      index: 3,
      titleIncludes: 'Build report',
      ignored: 'not forwarded'
    });
    assert.strictEqual(result.data.success, true);
    assert.strictEqual(captured.index, 3);
    assert.strictEqual(captured.titleIncludes, 'Build report');
    assert.strictEqual(captured.textIncludes, undefined);
    assert.strictEqual(captured.ignored, undefined);
  });

  await test('submit_solo_chat_task delegates task and Solo criteria to client', async () => {
    let captured = null;
    const client = {
      submitSoloChatTask: async (task, options) => {
        captured = { task, options };
        return { status: 202, data: { taskId: 'task_solo_1', status: 'executing' } };
      }
    };

    const result = await executeCommand(client, 'submit_solo_chat_task', {
      task: 'Implement feature',
      soloChatTitleIncludes: 'Feature chat',
      includeProcessText: true
    });

    assert.strictEqual(result.data.taskId, 'task_solo_1');
    assert.ok(captured.task.includes('Implement feature'));
    assert.strictEqual(captured.options.soloChatTitleIncludes, 'Feature chat');
    assert.strictEqual(captured.options.includeProcessText, true);
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
