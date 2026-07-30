'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeCommand, listCommands, runCleanupQueueWatchStatus } = require('./command-set');

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

  await test('open_project exposes and forwards newInstance', async () => {
    const command = listCommands().find(item => item.command === 'open_project');
    assert.ok(command.optional.includes('newInstance'));

    let captured = null;
    const client = {
      openProject: async (projectPath, options) => {
        captured = { projectPath, options };
        return { status: 200, data: { opened: true } };
      }
    };

    await executeCommand(client, 'open_project', {
      projectPath: '/tmp/second-project',
      newInstance: true
    });

    assert.deepStrictEqual(captured, {
      projectPath: '/tmp/second-project',
      options: { newInstance: true }
    });
  });

  await test('solo chat commands are exposed for real Solo sidebar control', async () => {
    const commands = listCommands();
    const list = commands.find(command => command.command === 'list_solo_chats');
    const switchChat = commands.find(command => command.command === 'switch_solo_chat');
    const cleanup = commands.find(command => command.command === 'cleanup_foreign_solo_queue');
    const cleanupWatch = commands.find(command => command.command === 'cleanup_queue_watch_status');
    const submit = commands.find(command => command.command === 'submit_solo_chat_task');

    assert.ok(list);
    assert.deepStrictEqual(list.required, []);
    assert.ok(switchChat);
    assert.ok(switchChat.optional.includes('index'));
    assert.ok(switchChat.optional.includes('titleIncludes'));
    assert.ok(switchChat.optional.includes('textIncludes'));
    assert.ok(cleanup);
    assert.deepStrictEqual(cleanup.required, []);
    assert.ok(cleanup.optional.includes('dryRun'));
    assert.ok(cleanup.optional.includes('execute'));
    assert.ok(cleanupWatch);
    assert.deepStrictEqual(cleanupWatch.required, []);
    assert.ok(cleanupWatch.optional.includes('lockFile'));
    assert.ok(submit);
    assert.deepStrictEqual(submit.required, ['task']);
    assert.ok(submit.optional.includes('soloChat'));
    assert.ok(submit.optional.includes('soloChatTitleIncludes'));
    assert.ok(submit.optional.includes('queueMaxWaitMs'));
  });

  await test('delegate_async exposes session and long-queue Solo ownership options', async () => {
    const commands = listCommands();
    const delegateAsync = commands.find(command => command.command === 'delegate_async');

    assert.ok(delegateAsync);
    assert.ok(delegateAsync.optional.includes('sessionId'));
    assert.ok(delegateAsync.optional.includes('soloChat'));
    assert.ok(delegateAsync.optional.includes('soloChatTitleIncludes'));
    assert.ok(delegateAsync.optional.includes('forceBackground'));
    assert.ok(delegateAsync.optional.includes('maxQueueWaitMs'));
    assert.ok(delegateAsync.optional.includes('queueMaxWaitMs'));
  });

  await test('long queue proof commands are exposed with dry-run-safe start controls', async () => {
    const commands = listCommands();
    const start = commands.find(command => command.command === 'long_queue_proof_start');
    const status = commands.find(command => command.command === 'long_queue_proof_status');
    const cancel = commands.find(command => command.command === 'long_queue_proof_cancel');

    assert.ok(start);
    assert.deepStrictEqual(start.required, []);
    assert.ok(start.optional.includes('execute'));
    assert.ok(start.optional.includes('allowQuotaSpend'));
    assert.ok(start.optional.includes('detach'));
    assert.ok(start.optional.includes('cleanupStabilizeChecks'));
    assert.ok(status);
    assert.deepStrictEqual(status.required, []);
    assert.ok(status.optional.includes('marker'));
    assert.ok(cancel);
    assert.deepStrictEqual(cancel.required, []);
    assert.ok(cancel.optional.includes('taskId'));
  });

  await test('long queue proof commands use client hooks when available', async () => {
    const calls = [];
    const client = {
      longQueueProofStart: async params => {
        calls.push({ name: 'start', params });
        return { status: 200, data: { status: 'dry_run', executeRequired: true } };
      },
      longQueueProofStatus: async params => {
        calls.push({ name: 'status', params });
        return { status: 200, data: { status: 'missing' } };
      },
      longQueueProofCancel: async params => {
        calls.push({ name: 'cancel', params });
        return { status: 200, data: { status: 'cancel_requested' } };
      }
    };

    const start = await executeCommand(client, 'long_queue_proof_start', { marker: 'TRAECN_GLM52_SAFE', execute: false });
    const status = await executeCommand(client, 'long_queue_proof_status', { marker: 'TRAECN_GLM52_SAFE' });
    const cancel = await executeCommand(client, 'long_queue_proof_cancel', { marker: 'TRAECN_GLM52_SAFE' });

    assert.strictEqual(start.data.executeRequired, true);
    assert.strictEqual(status.data.status, 'missing');
    assert.strictEqual(cancel.data.status, 'cancel_requested');
    assert.deepStrictEqual(calls.map(call => call.name), ['start', 'status', 'cancel']);
    assert.strictEqual(calls[0].params.execute, false);
  });

  await test('long queue proof start forwards explicit quota approval flag', async () => {
    const calls = [];
    const client = {
      longQueueProofStart: async params => {
        calls.push(params);
        return { status: 200, data: { status: 'quota_approval_required' } };
      }
    };

    await executeCommand(client, 'long_queue_proof_start', {
      marker: 'TRAECN_GLM52_SAFE',
      execute: true,
      allowQuotaSpend: true
    });

    assert.strictEqual(calls[0].execute, true);
    assert.strictEqual(calls[0].allowQuotaSpend, true);
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

  await test('cleanup_foreign_solo_queue delegates dry-run and execute flags', async () => {
    let captured = null;
    const client = {
      cleanupForeignSoloQueue: async (options) => {
        captured = options;
        return { status: 200, data: { matched: 1, deleted: 1 } };
      }
    };

    const result = await executeCommand(client, 'cleanup_foreign_solo_queue', {
      dryRun: false,
      execute: true,
      maxPasses: 10,
      settleMs: 250
    });
    assert.strictEqual(result.data.deleted, 1);
    assert.strictEqual(captured.dryRun, false);
    assert.strictEqual(captured.execute, true);
    assert.strictEqual(captured.maxPasses, 10);
    assert.strictEqual(captured.settleMs, 250);
  });

  await test('cleanup_queue_watch_status uses client hook when available', async () => {
    let captured = null;
    const client = {
      cleanupQueueWatchStatus: async (options) => {
        captured = options;
        return { status: 200, data: { mode: 'watch_status', running: true, pid: 123 } };
      }
    };

    const result = await executeCommand(client, 'cleanup_queue_watch_status', {
      lockFile: '/tmp/cleanup-watch.lock'
    });
    assert.strictEqual(result.data.mode, 'watch_status');
    assert.strictEqual(result.data.running, true);
    assert.strictEqual(captured.lockFile, '/tmp/cleanup-watch.lock');
  });

  await test('cleanup_queue_watch_status fallback reads local lock state only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-command-cleanup-status-'));
    const lockFile = path.join(dir, 'cleanup-watch.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, startedAt: 'stale' }));

    const result = runCleanupQueueWatchStatus({ lockFile });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.data.mode, 'watch_status');
    assert.strictEqual(result.data.running, false);
    assert.strictEqual(result.data.stale, true);
    assert.strictEqual(result.data.lockFile, lockFile);
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
      includeProcessText: true,
      queueMaxWaitMs: 600000
    });

    assert.strictEqual(result.data.taskId, 'task_solo_1');
    assert.ok(captured.task.includes('Implement feature'));
    assert.strictEqual(captured.options.soloChatTitleIncludes, 'Feature chat');
    assert.strictEqual(captured.options.includeProcessText, true);
    assert.strictEqual(captured.options.queueMaxWaitMs, 600000);
  });

  await test('delegate_async forwards session and long-queue ownership options', async () => {
    let captured = null;
    const client = {
      delegateAsync: async (task, options) => {
        captured = { task, options };
        return { status: 202, data: { taskId: 'task_async_owned', status: 'queued' } };
      }
    };

    const result = await executeCommand(client, 'delegate_async', {
      task: 'Owned long queue task',
      sessionId: 'session_a',
      soloChatTitleIncludes: 'Feature chat',
      forceBackground: true,
      maxQueueWaitMs: 3600000,
      queueMaxWaitMs: 3600000
    });

    assert.strictEqual(result.data.taskId, 'task_async_owned');
    assert.ok(captured.task.includes('Owned long queue task'));
    assert.strictEqual(captured.options.sessionId, 'session_a');
    assert.strictEqual(captured.options.soloChatTitleIncludes, 'Feature chat');
    assert.strictEqual(captured.options.forceBackground, true);
    assert.strictEqual(captured.options.maxQueueWaitMs, 3600000);
    assert.strictEqual(captured.options.queueMaxWaitMs, 3600000);
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

  await test('vibe_workflow preserves explicit human review checkpoints', async () => {
    let captured = null;
    const client = {
      delegateAsync: async (task, options) => {
        captured = { task, options };
        return { status: 202, data: { taskId: 'task_reviewed_workflow', status: 'queued' } };
      }
    };

    await executeCommand(client, 'vibe_workflow', {
      task: 'Implement feature',
      reviewRequired: true,
      autoContinue: false,
      steps: ['Run tests', { task: 'Update changelog', reviewRequired: true }]
    });

    assert.strictEqual(captured.options.autoContinue, false);
    assert.strictEqual(captured.options.followupTasks[0].autoContinue, false);
    assert.strictEqual(captured.options.followupTasks[1].autoContinue, false);
  });

  await test('vibe_workflow catalog advertises human review controls', async () => {
    const command = listCommands().find(item => item.command === 'vibe_workflow');
    assert.ok(command.optional.includes('reviewRequired'));
    assert.ok(command.optional.includes('autoContinue'));
  });

  await test('review_task exposes and resolves a gateway task checkpoint', async () => {
    const command = listCommands().find(item => item.command === 'review_task');
    assert.ok(command);
    assert.deepStrictEqual(command.required, ['taskId', 'decision']);
    assert.ok(command.optional.includes('notes'));

    let captured = null;
    const client = {
      resolveTaskReview: async (taskId, decision, notes) => {
        captured = { taskId, decision, notes };
        return { status: 200, data: { taskId, status: 'continued' } };
      }
    };

    const result = await executeCommand(client, 'review_task', {
      taskId: 'task_review_1',
      decision: 'approve',
      notes: 'looks good'
    });

    assert.strictEqual(result.data.status, 'continued');
    assert.deepStrictEqual(captured, {
      taskId: 'task_review_1',
      decision: 'approve',
      notes: 'looks good'
    });
  });

  console.log(`\n[command-set.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('[command-set.test.js] Fatal error:', err);
  process.exit(1);
});
