'use strict';

const assert = require('assert');
const { createRunner } = require('../../shared/test-runner');
const stateApi = require('./state');

const runner = createRunner('web-console/state.test.js');
const { test, summary } = runner;

console.log('\n[web-console/state.test.js] Running console state tests...\n');

test('createInitialState returns independent normalized projections', () => {
  const first = stateApi.createInitialState();
  const second = stateApi.createInitialState();
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual(first.context, {
    workspace: null,
    model: null,
    mode: null,
    conversation: null,
  });
  first.ui.notices.push({ id: 'local' });
  assert.strictEqual(second.ui.notices.length, 0);
});

test('normalizeStatus maps durable history aliases to console statuses', () => {
  assert.strictEqual(stateApi.normalizeStatus('accepted'), 'queued');
  assert.strictEqual(stateApi.normalizeStatus('completed'), 'done');
  assert.strictEqual(stateApi.normalizeStatus('failed'), 'error');
  assert.strictEqual(stateApi.normalizeStatus('running'), 'executing');
  assert.strictEqual(stateApi.normalizeStatus('pending'), 'queued');
  assert.strictEqual(stateApi.normalizeStatus('approval_required'), 'approval_required');
});

test('normalizeTask preserves task identity, context, result, and interaction identity', () => {
  const task = stateApi.normalizeTask({
    taskId: 'task-context-1',
    task: 'Review the current project',
    status: 'approval_required',
    createdAt: '2026-08-24T00:00:00.000Z',
    timestamp: '2026-08-24T00:00:10.000Z',
    projectPath: '/workspace/project',
    currentModel: 'GLM-5.3',
    mode: 'solo',
    soloChat: { titleIncludes: 'Project review' },
    interactionRequestId: 'interaction-1',
    result: {
      text: 'A command needs approval',
      dialogType: 'command_approval',
      question: 'Run this command?',
      command: 'npm test',
      commandRisk: 'medium',
      riskReasons: ['executes a process'],
      buttons: ['Approve', { label: 'Deny', description: 'Do not run it' }],
    },
  });

  assert.strictEqual(task.taskId, 'task-context-1');
  assert.strictEqual(task.message, 'Review the current project');
  assert.deepStrictEqual(task.context, {
    workspace: '/workspace/project',
    model: 'GLM-5.3',
    mode: 'solo',
    conversation: 'Project review',
  });
  assert.strictEqual(task.result.text, 'A command needs approval');
  assert.strictEqual(task.interaction.interactionRequestId, 'interaction-1');
  assert.strictEqual(task.interaction.command, 'npm test');
  assert.deepStrictEqual(
    task.interaction.buttons.map((item) => item.label),
    ['Approve', 'Deny']
  );
});

test('normalizeTask ignores an older timestamped payload', () => {
  const current = stateApi.normalizeTask({
    taskId: 'task-stale-1',
    status: 'executing',
    timestamp: 200,
  });
  const stale = stateApi.normalizeTask(
    {
      taskId: 'task-stale-1',
      status: 'queued',
      timestamp: 100,
    },
    current
  );
  assert.strictEqual(stale, current);
});

test('normalizeTask never regresses a terminal task to an active status', () => {
  const complete = stateApi.normalizeTask({
    taskId: 'task-terminal-1',
    status: 'done',
    timestamp: 100,
    result: { text: 'Complete', stable: true },
  });
  const lateActive = stateApi.normalizeTask(
    {
      taskId: 'task-terminal-1',
      status: 'executing',
      timestamp: 200,
    },
    complete
  );
  assert.strictEqual(lateActive, complete);
  assert.strictEqual(lateActive.result.text, 'Complete');
});

test('selectors sort exceptional, active, and terminal tasks deterministically', () => {
  let state = stateApi.createInitialState();
  const tasks = [
    { taskId: 'done-new', status: 'done', createdAt: 500 },
    { taskId: 'queued-old', status: 'queued', createdAt: 100 },
    { taskId: 'approval', status: 'approval_required', createdAt: 300 },
    { taskId: 'running', status: 'executing', createdAt: 200 },
    { taskId: 'review', status: 'awaiting_review', createdAt: 400 },
    { taskId: 'done-old', status: 'done', createdAt: 50 },
  ];
  state = stateApi.reduceState(state, { type: 'HYDRATE_TASKS', tasks });

  assert.deepStrictEqual(
    stateApi.sortedTasks(state).map((task) => task.taskId),
    ['approval', 'review', 'running', 'queued-old', 'done-new', 'done-old']
  );
  assert.deepStrictEqual(
    stateApi.selectAttentionTasks(state).map((task) => task.taskId),
    ['approval', 'review']
  );
  assert.deepStrictEqual(
    stateApi.selectActiveTasks(state).map((task) => task.taskId),
    ['running', 'queued-old']
  );
  assert.deepStrictEqual(
    stateApi.selectTerminalTasks(state).map((task) => task.taskId),
    ['done-new', 'done-old']
  );
});

test('every gateway terminal status remains terminal', () => {
  for (const status of ['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected']) {
    assert.strictEqual(stateApi.isTerminalStatus(status), true, status);
    assert.strictEqual(stateApi.isActiveStatus(status), false, status);
  }
});

test('socket close marks active tasks stale without reinterpreting their status', () => {
  let state = stateApi.reduceState(stateApi.createInitialState(), {
    type: 'HYDRATE_TASKS',
    tasks: [
      { taskId: 'task-active', status: 'executing' },
      { taskId: 'task-complete', status: 'done' },
    ],
  });
  state = stateApi.reduceState(state, { type: 'SOCKET_CLOSED', attempt: 3 });

  assert.strictEqual(state.connection.socket, 'closed');
  assert.strictEqual(state.connection.stale, true);
  assert.strictEqual(state.connection.reconnectAttempt, 3);
  assert.strictEqual(state.tasks['task-active'].status, 'executing');
  assert.strictEqual(state.tasks['task-active'].stale, true);
  assert.strictEqual(state.tasks['task-complete'].stale, false);
});

test('authoritative active hydration marks missing work stale instead of failed', () => {
  let state = stateApi.reduceState(stateApi.createInitialState(), {
    type: 'HYDRATE_TASKS',
    tasks: [
      { taskId: 'task-present', status: 'executing' },
      { taskId: 'task-missing', status: 'queued' },
    ],
  });
  state = stateApi.reduceState(state, {
    type: 'HYDRATE_TASKS',
    tasks: [{ taskId: 'task-present', status: 'executing' }],
    authoritativeActive: true,
  });

  assert.strictEqual(state.tasks['task-present'].stale, false);
  assert.strictEqual(state.tasks['task-missing'].status, 'queued');
  assert.strictEqual(state.tasks['task-missing'].stale, true);
});

test('history pages normalize aliases and append without duplicate identities', () => {
  let state = stateApi.reduceState(stateApi.createInitialState(), {
    type: 'HISTORY',
    page: {
      tasks: [{ taskId: 'history-1', status: 'completed', task: 'First' }],
      pagination: { page: 1, hasNext: true },
    },
  });
  state = stateApi.reduceState(state, {
    type: 'HISTORY',
    append: true,
    page: {
      tasks: [
        { taskId: 'history-1', status: 'completed', task: 'First' },
        { taskId: 'history-2', status: 'failed', task: 'Second' },
      ],
      pagination: { page: 2, hasNext: false },
    },
  });

  assert.deepStrictEqual(
    state.history.items.map((item) => item.taskId),
    ['history-1', 'history-2']
  );
  assert.deepStrictEqual(
    state.history.items.map((item) => item.status),
    ['done', 'error']
  );
  assert.strictEqual(state.history.pagination.page, 2);
});

test('classifySocketEvent separates complete task payloads from refresh hints', () => {
  assert.deepStrictEqual(
    stateApi.classifySocketEvent({
      type: 'taskUpdate',
      taskId: 'task-1',
      status: 'executing',
    }).kind,
    'task'
  );
  const refresh = stateApi.classifySocketEvent({
    type: 'taskStatusChanged',
    taskId: 'task-2',
    status: 'done',
  });
  assert.strictEqual(refresh.kind, 'refresh');
  assert.strictEqual(refresh.taskId, 'task-2');

  const durable = stateApi.classifySocketEvent({
    type: 'event',
    eventType: 'task_completed',
    data: { taskId: 'task-3', status: 'done' },
  });
  assert.strictEqual(durable.kind, 'refresh');
  assert.strictEqual(durable.taskId, 'task-3');
});

test('unknown socket events create bounded redacted diagnostics', () => {
  let state = stateApi.createInitialState();
  for (let index = 0; index < stateApi.MAX_DIAGNOSTICS + 5; index++) {
    state = stateApi.reduceSocketEvent(state, {
      type: `unknown-${index}`,
      token: 'must-not-survive',
      nested: { authorization: 'Bearer hidden', visible: 'ok' },
    });
  }

  assert.strictEqual(state.ui.diagnostics.length, stateApi.MAX_DIAGNOSTICS);
  assert.strictEqual(state.ui.diagnostics[0].detail.token, '[REDACTED]');
  assert.strictEqual(state.ui.diagnostics[0].detail.nested.authorization, '[REDACTED]');
  assert.strictEqual(state.ui.diagnostics[0].detail.nested.visible, 'ok');
});

test('locking protected state retains only stale task projections', () => {
  let state = stateApi.reduceState(stateApi.createInitialState(), {
    type: 'UPSERT_TASK',
    task: { taskId: 'task-visible', status: 'executing', task: 'Visible non-secret task' },
  });
  state = stateApi.reduceState(state, {
    type: 'CONTEXT',
    context: { workspace: '/private/workspace', model: 'Private model' },
  });
  state = stateApi.reduceState(state, { type: 'LOCK_PROTECTED' });

  assert.strictEqual(state.connection.auth, 'locked');
  assert.strictEqual(state.context.workspace, null);
  assert.strictEqual(state.history.loaded, false);
  assert.strictEqual(state.tasks['task-visible'].message, 'Visible non-secret task');
  assert.strictEqual(state.tasks['task-visible'].stale, true);
});

summary();
if (runner.failed > 0) process.exitCode = 1;
