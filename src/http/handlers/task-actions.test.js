'use strict';

const assert = require('assert');
const { createRunner } = require('../../shared/test-runner');
const { makeReqRes } = require('../../shared/test-helpers');
const { generateOpenAPISpec } = require('../openapi');
const { ROUTES, handleTaskStatus, handleTaskInteraction, visibleInteractionMatches } = require('./task-actions');

const runner = createRunner('handlers/task-actions.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[handlers/task-actions.test.js] Running task action handler tests...\n');

function makeContext(task, driverOverrides = {}) {
  const calls = [];
  const audits = [];
  const taskQueue = new Map(task ? [[task.taskId, task]] : []);
  const driver = {
    checkForApprovalDialog: async () => ({
      needsApproval: true,
      dialogType: task?.result?.dialogType || 'question',
      question: task?.result?.question || task?.result?.text || '',
      command: task?.result?.command || null,
      isCommandExec: Boolean(task?.result?.command),
    }),
    answerQuestionDialog: async (answer) => {
      calls.push(['answer', answer]);
      return { success: true, selectedOption: answer };
    },
    approveDialog: async (action) => {
      calls.push(['approve', action]);
      return { success: true, buttonClicked: action };
    },
    ...driverOverrides,
  };
  const ctx = {
    taskQueue,
    driver,
    auditLogger: { log: (entry) => audits.push(entry) },
    _ensureConnection: async () => {
      calls.push(['connect']);
    },
    _withUiActionLock: async (action) => {
      calls.push(['lock']);
      return action();
    },
    _resumeApprovalRequiredTasksAfterDialogAnswer: (answer, result, expectedTaskId) => {
      calls.push(['resume-answer', answer, expectedTaskId]);
      return [expectedTaskId];
    },
    _resumeApprovalRequiredTasksAfterInteraction: (action, dialog, result, expectedTaskId) => {
      calls.push(['resume-interaction', action, dialog.command, expectedTaskId]);
      return [expectedTaskId];
    },
    _json(_req, res, data, statusCode = 200) {
      res.statusCode = statusCode;
      res._body = JSON.stringify(data);
      return data;
    },
  };
  return { ctx, calls, audits };
}

async function invoke(taskId, body, setup) {
  const { req, res } = makeReqRes({}, `/api/task/${taskId}/interaction`, 'POST', body);
  await handleTaskInteraction(req, res, setup.ctx, taskId);
  return { res, body: JSON.parse(res._body) };
}

test('task interaction route is authenticated, rate-limited, and task-bound', () => {
  const route = ROUTES.find((item) => item.path === '/api/task/:taskId/interaction');
  assert.ok(route);
  assert.strictEqual(route.method, 'POST');
  assert.strictEqual(route.handler, '_handleTaskInteraction');
  assert.strictEqual(route.requiresAuth, true);
  assert.strictEqual(route.requiresRateLimit, true);
  assert.strictEqual(route.requiresBody, true);
  assert.deepStrictEqual(route.pathParams, ['taskId']);
});

asyncTest('active task status exposes only actual workflow links in gateway metadata', async () => {
  const createdAt = Date.now() - 1000;
  for (const fields of [
    { nextTaskId: 'task-real-child' },
    { workflowParentTaskId: 'task-real-parent' },
    { nextTaskId: 'task-real-child', workflowParentTaskId: 'task-real-parent' }
  ]) {
    const task = {
      taskId: 'task-workflow-snapshot', status: 'done', createdAt,
      metadata: { source: 'owned-workflow', custom: { retained: true } },
      result: { text: 'Reviewed result', stable: true },
      ...fields
    };
    const setup = makeContext(task);
    const { req, res } = makeReqRes({}, `/api/task/${task.taskId}`, 'GET');
    await handleTaskStatus(req, res, setup.ctx, task.taskId);
    const response = JSON.parse(res._body);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(response.metadata, { ...task.metadata, ...fields });
    assert.strictEqual(response.taskId, task.taskId);
    assert.strictEqual(response.status, 'done');
    assert.strictEqual(response.result.text, task.result.text);
    assert.deepStrictEqual(task.metadata, { source: 'owned-workflow', custom: { retained: true } });
    assert.deepStrictEqual(setup.calls, [], 'snapshot projection must not perform UI actions');
  }
});

asyncTest('task status does not invent workflow links for a standalone task', async () => {
  const task = {
    taskId: 'task-standalone-snapshot', status: 'done', createdAt: Date.now(),
    result: { text: 'Standalone result', stable: true }
  };
  const setup = makeContext(task);
  const { req, res } = makeReqRes({}, `/api/task/${task.taskId}`, 'GET');
  await handleTaskStatus(req, res, setup.ctx, task.taskId);
  const response = JSON.parse(res._body);
  assert.strictEqual(response.metadata, undefined);
});

test('visible interaction matching is fail-closed for command and question identity', () => {
  const commandTask = {
    result: { dialogType: 'command_approval', command: 'npm test' },
  };
  assert.strictEqual(
    visibleInteractionMatches(commandTask, {
      needsApproval: true,
      dialogType: 'command_approval',
      command: 'npm test',
    }),
    true
  );
  assert.strictEqual(
    visibleInteractionMatches(commandTask, {
      needsApproval: true,
      dialogType: 'command_approval',
      command: 'npm publish',
    }),
    false
  );
  assert.strictEqual(
    visibleInteractionMatches(
      {
        result: { dialogType: 'question', question: 'Choose scope' },
      },
      {
        needsApproval: true,
        dialogType: 'question',
        question: 'Choose another scope',
      }
    ),
    false
  );
  assert.strictEqual(visibleInteractionMatches(commandTask, null), false);
});

asyncTest(
  'missing interaction identity is rejected before connection or driver access',
  async () => {
    const task = {
      taskId: 'task-missing-id',
      status: 'approval_required',
      interactionRequestId: 'interaction-current',
      result: { dialogType: 'question', question: 'Choose scope' },
    };
    const setup = makeContext(task);
    const result = await invoke(task.taskId, { action: 'answer', answer: 'Current' }, setup);
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.body.error, 'interactionRequestId is required');
    assert.deepStrictEqual(setup.calls, []);
  }
);

asyncTest('missing task and stale task status apply no driver action', async () => {
  const missingSetup = makeContext(null);
  const missing = await invoke(
    'task-absent',
    {
      interactionRequestId: 'interaction-absent',
      action: 'dismiss',
    },
    missingSetup
  );
  assert.strictEqual(missing.res.statusCode, 404);
  assert.deepStrictEqual(missingSetup.calls, [['lock']]);

  const staleTask = {
    taskId: 'task-stale-status',
    status: 'executing',
    interactionRequestId: 'interaction-old',
    result: { dialogType: 'question', question: 'Old question' },
  };
  const staleSetup = makeContext(staleTask);
  const stale = await invoke(
    staleTask.taskId,
    {
      interactionRequestId: 'interaction-old',
      action: 'dismiss',
    },
    staleSetup
  );
  assert.strictEqual(stale.res.statusCode, 409);
  assert.deepStrictEqual(staleSetup.calls, [['lock']]);
});

asyncTest('stale interaction request identity applies no driver action', async () => {
  const task = {
    taskId: 'task-stale-id',
    status: 'approval_required',
    interactionRequestId: 'interaction-current',
    result: { dialogType: 'question', question: 'Current question' },
  };
  const setup = makeContext(task);
  const result = await invoke(
    task.taskId,
    {
      interactionRequestId: 'interaction-old',
      action: 'dismiss',
    },
    setup
  );
  assert.strictEqual(result.res.statusCode, 409);
  assert.strictEqual(result.body.error, 'task_interaction_conflict');
  assert.deepStrictEqual(setup.calls, [['lock']]);
});

asyncTest('visible dialog mismatch applies no answer or approval action', async () => {
  const task = {
    taskId: 'task-dialog-changed',
    status: 'approval_required',
    interactionRequestId: 'interaction-current',
    result: { dialogType: 'question', question: 'Original question', options: ['One'] },
  };
  const setup = makeContext(task, {
    checkForApprovalDialog: async () => ({
      needsApproval: true,
      dialogType: 'question',
      question: 'Different question',
    }),
  });
  const result = await invoke(
    task.taskId,
    {
      interactionRequestId: 'interaction-current',
      action: 'answer',
      answer: 'One',
    },
    setup
  );
  assert.strictEqual(result.res.statusCode, 409);
  assert.strictEqual(result.body.error, 'task_interaction_conflict');
  assert.deepStrictEqual(setup.calls, [['lock'], ['connect']]);
});

asyncTest('question answer must exactly match a current option label', async () => {
  const task = {
    taskId: 'task-option',
    status: 'approval_required',
    interactionRequestId: 'interaction-option',
    result: {
      dialogType: 'question',
      question: 'Choose scope',
      options: [{ label: 'Current workspace' }, { label: 'All files' }],
    },
  };
  const setup = makeContext(task);
  const result = await invoke(
    task.taskId,
    {
      interactionRequestId: 'interaction-option',
      action: 'answer',
      answer: 'current workspace',
    },
    setup
  );
  assert.strictEqual(result.res.statusCode, 400);
  assert.strictEqual(result.body.error, 'answer_option_mismatch');
  assert.deepStrictEqual(setup.calls, [['lock'], ['connect']]);
});

asyncTest('question answer resolves and resumes only the exact task identity', async () => {
  const task = {
    taskId: 'task-answer',
    status: 'approval_required',
    interactionRequestId: 'interaction-answer',
    result: {
      dialogType: 'question',
      question: 'Choose scope',
      options: ['Current workspace', 'All files'],
    },
  };
  const setup = makeContext(task);
  const result = await invoke(
    task.taskId,
    {
      interactionRequestId: 'interaction-answer',
      action: 'answer',
      answer: 'Current workspace',
    },
    setup
  );
  assert.strictEqual(result.res.statusCode, 200);
  assert.deepStrictEqual(result.body.resumedTaskIds, ['task-answer']);
  assert.ok(setup.calls.some((call) => call[0] === 'answer' && call[1] === 'Current workspace'));
  assert.ok(setup.calls.some((call) => call[0] === 'resume-answer' && call[2] === 'task-answer'));
});

asyncTest(
  'command approval requires exact command, acknowledgement, and audit reason',
  async () => {
    const task = {
      taskId: 'task-command-context',
      status: 'approval_required',
      interactionRequestId: 'interaction-command',
      result: {
        dialogType: 'command_approval',
        question: 'Run npm test?',
        command: 'npm test',
      },
    };
    const setup = makeContext(task);
    const result = await invoke(
      task.taskId,
      {
        interactionRequestId: 'interaction-command',
        action: 'approve',
        expectedCommand: 'npm test',
      },
      setup
    );
    assert.strictEqual(result.res.statusCode, 400);
    assert.strictEqual(result.body.error, 'approval_authorization_context_required');
    assert.strictEqual(
      setup.calls.some((call) => call[0] === 'approve'),
      false
    );
  }
);

asyncTest('command mismatch returns 409 and applies no approval', async () => {
  const task = {
    taskId: 'task-command-mismatch',
    status: 'approval_required',
    interactionRequestId: 'interaction-command',
    result: {
      dialogType: 'command_approval',
      question: 'Run npm test?',
      command: 'npm test',
    },
  };
  const setup = makeContext(task);
  const result = await invoke(
    task.taskId,
    {
      interactionRequestId: 'interaction-command',
      action: 'approve',
      expectedCommand: 'npm publish',
      acknowledgeRisk: true,
      reason: 'Run the test suite',
    },
    setup
  );
  assert.strictEqual(result.res.statusCode, 409);
  assert.strictEqual(result.body.error, 'approval_command_mismatch');
  assert.strictEqual(
    setup.calls.some((call) => call[0] === 'approve'),
    false
  );
});

asyncTest('exact command approval audits and resumes only the named task', async () => {
  const task = {
    taskId: 'task-command-success',
    status: 'approval_required',
    interactionRequestId: 'interaction-command',
    result: {
      dialogType: 'command_approval',
      question: 'Run npm test?',
      command: 'npm test',
    },
  };
  const setup = makeContext(task);
  const result = await invoke(
    task.taskId,
    {
      interactionRequestId: 'interaction-command',
      action: 'approve',
      expectedCommand: 'npm test',
      acknowledgeRisk: true,
      reason: 'Run the repository tests',
    },
    setup
  );
  assert.strictEqual(result.res.statusCode, 200);
  assert.deepStrictEqual(result.body.resumedTaskIds, ['task-command-success']);
  assert.ok(setup.calls.some((call) => call[0] === 'approve' && call[1] === 'approve'));
  assert.ok(
    setup.calls.some(
      (call) => call[0] === 'resume-interaction' && call[3] === 'task-command-success'
    )
  );
  assert.strictEqual(setup.audits.at(-1).resource, 'trae:task:task-command-success');
  assert.strictEqual(setup.audits.at(-1).params.reason, 'Run the repository tests');
});

test('OpenAPI documents task and interaction identity plus fail-closed responses', () => {
  const operation = generateOpenAPISpec().paths['/api/task/{taskId}/interaction'].post;
  assert.strictEqual(operation.operationId, 'resolveTaskInteraction');
  assert.deepStrictEqual(operation.requestBody.content['application/json'].schema.required, [
    'interactionRequestId',
    'action',
  ]);
  assert.ok(operation.responses['400']);
  assert.ok(operation.responses['404']);
  assert.match(operation.responses['409'].description, /no action applied/i);
  assert.ok(operation.responses['501']);
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
