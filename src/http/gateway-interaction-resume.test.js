'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { Gateway } = require('./gateway');
const { TaskQueueService } = require('./task-queue-service');
const { TaskHistoryStore } = require('../shared/task-history');
const { createRunner } = require('../shared/test-runner');
const { handleResolveInteraction } = require('./handlers/unified-agent');
const { handleTaskInteraction } = require('./handlers/task-actions');

const r = createRunner('gateway-interaction-resume.test.js');
const command = "node '/tmp/approval fixture.js'; echo 'complete'";
const dialog = { needsApproval: true, isCommandExec: true, dialogType: 'command_execution', command };

function task(taskId, fields = {}) {
  return {
    taskId, task: 'Complete this isolated approval fixture', status: 'approval_required',
    createdAt: Date.now(), submittedToTrae: true, submittedAt: Date.now() - 1000,
    interactionRequestId: `${taskId}-interaction`, queueState: 'paused',
    result: { command, dialogType: 'command_execution', question: '是否允许运行这个命令？', text: 'Retained partial output' },
    ...fields
  };
}

function fixture(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-interaction-resume-'));
  const logger = { log() {}, warn() {}, error() {} };
  const historyPath = path.join(dir, 'history.json');
  const history = new TaskHistoryStore({ persistencePath: historyPath, logger });
  const service = new TaskQueueService({ persistencePath: path.join(dir, 'queue.json'), taskHistoryStore: history, logger });
  const calls = { persist: 0, poll: 0, notifications: 0, decisions: [], activeReads: 0, answer: 0, native: 0 };
  const gateway = Object.assign(Object.create(Gateway.prototype), {
    taskQueue: new Map(tasks.map(item => [item.taskId, item])), taskHistoryStore: history, taskQueueService: service,
    uiActionChain: Promise.resolve(),
    _ensureConnection: async () => {},
    _ensureBackgroundPolling: () => { calls.poll++; },
    wsHandler: { notifyTaskStatusChange: () => { calls.notifications++; } },
    _json: (_req, res, body, status = 200) => Object.assign(res, { body, status }),
    driver: {
      checkForApprovalDialog: async () => ({ ...dialog }),
      detectMode: async () => ({ mode: 'solo' }),
      approveDialog: async (action, options) => { calls.decisions.push({ action, options }); return { success: true, buttonClicked: action }; },
      answerQuestionDialog: async () => { calls.answer++; return { success: true }; },
      sendMessage: async () => { calls.native++; throw new Error('interaction resolution must not submit model work'); }
    }
  });
  gateway._persistActiveQueue = () => { calls.persist++; return service.persist(gateway.taskQueue); };
  for (const item of tasks) gateway._syncTaskHistoryMirror(item);
  assert.strictEqual(service.persist(gateway.taskQueue), true);
  return {
    dir, historyPath, history, service, gateway, calls,
    resume: (expectedTaskId = null, context = {}, visible = dialog) => gateway._resumeApprovalRequiredTasksAfterInteraction(
      'deny', visible, { success: true, buttonClicked: 'Skip' }, expectedTaskId, context
    ),
    active(sessionId) {
      gateway.driver.getActiveSoloChat = async () => {
        assert.strictEqual(gateway.uiActionInFlight, 1, 'fresh native identity must be read inside the UI lock');
        calls.activeReads++;
        return { active: sessionId ? { sessionId, title: 'Same misleading title' } : null };
      };
    },
    close() { service.close(); history.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  return req;
}

function approvalBody(expectedCommand = command) {
  return { action: 'approve', expectedCommand, acknowledgeRisk: true, reason: 'User authorized this exact isolated fixture command' };
}

(async () => {
  await r.asyncTest('stored full command resumes a generic-heading task and persists its original identity and partial result', async () => {
    const owned = task('exact');
    const originalResult = { ...owned.result };
    const f = fixture([owned]);
    try {
      assert.deepStrictEqual(f.resume(), ['exact']);
      assert.strictEqual(owned.status, 'executing');
      assert.strictEqual(owned.interactionRequestId, undefined);
      assert.deepStrictEqual(owned.result, originalResult);
      assert.strictEqual(owned.answeredDialog.command, command);
      const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'queue.json'), 'utf8')).tasks;
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0].taskId, 'exact');
      assert.strictEqual(stored[0].status, 'executing');
      assert.deepStrictEqual(stored[0].result, originalResult);
      f.history.shutdown();
      const restored = new TaskHistoryStore({ persistencePath: f.historyPath });
      try {
        assert.strictEqual(restored.getTask('exact').status, 'executing');
        assert.deepStrictEqual(restored.getTask('exact').result, originalResult);
        assert.strictEqual(restored.getTask('exact').steps.filter(step => step.action === 'dialog_resolved').length, 1);
      } finally { restored.shutdown(); }
      assert.deepStrictEqual({ persist: f.calls.persist, poll: f.calls.poll, notifications: f.calls.notifications, native: f.calls.native },
        { persist: 1, poll: 1, notifications: 1, native: 0 });
    } finally { f.close(); }
  });

  for (const [name, result, visible] of [
    ['different stored command despite a matching quotation', { command: 'node another.js', question: `The previous command was ${command}` }, dialog],
    ['quoted text without a stored command', { question: `The log quoted "${command}" but asks about something else` }, dialog],
    ['text-pattern evidence without a stored command', { dialogType: 'text_pattern', question: `运行 ${command}？` }, dialog],
    ['non-command task containing the command', { dialogType: 'question', command, question: `Choose scope for ${command}` }, dialog],
    ['non-command visible dialog', { command, dialogType: 'command_execution' }, { needsApproval: true, isCommandExec: false, command }],
    ['missing visible command', { command, dialogType: 'command_execution' }, { needsApproval: true, isCommandExec: true }],
    ['different whitespace inside a quoted path', { command: "node '/tmp/a   b'", question: "运行 node '/tmp/a b'？" }, { ...dialog, command: "node '/tmp/a b'" }],
    ['a semicolon suffix beyond a matching prefix', { command: 'npm test; echo ready', question: '运行 npm test？' }, { ...dialog, command: 'npm test' }]
  ]) {
    r.test(`command recovery rejects ${name}`, () => {
      const owned = task('unchanged', { result });
      const f = fixture([owned]);
      try {
        assert.deepStrictEqual(f.resume(null, {}, visible), []);
        assert.strictEqual(owned.status, 'approval_required');
        assert.strictEqual(f.calls.persist + f.calls.poll + f.calls.notifications, 0);
      } finally { f.close(); }
    });
  }

  r.test('legacy explicit run question remains compatible without a native binding', () => {
    const owned = task('legacy', { result: { question: `运行 ${command}？` } });
    const f = fixture([owned]);
    try { assert.deepStrictEqual(f.resume(), ['legacy']); } finally { f.close(); }
  });

  r.test('storage-pending candidates stay paused for both existing pending flags', () => {
    for (const flag of ['statePersistencePending', 'cancelPersistencePending']) {
      const owned = task(flag, { [flag]: { previousStatus: 'approval_required' }, result: { question: `运行 ${command}？` } });
      const f = fixture([owned]);
      try {
        assert.deepStrictEqual(f.resume(owned.taskId), []);
        assert.strictEqual(owned.status, 'approval_required');
        assert.strictEqual(f.calls.persist + f.calls.poll, 0);
      } finally { f.close(); }
    }
  });

  r.test('fresh native identity selects its bound task instead of the newest same-command task', () => {
    const current = task('current', { createdAt: 1, soloChat: { sessionId: 'native-current', titleIncludes: 'same title' } });
    const other = task('newer', { createdAt: 2, soloChat: { sessionId: 'native-other', titleIncludes: 'same title' } });
    const f = fixture([current, other]);
    try {
      assert.deepStrictEqual(f.resume(null, { activeSessionId: 'native-current' }), ['current']);
      assert.strictEqual(other.status, 'approval_required');
    } finally { f.close(); }
  });

  r.test('missing native context never guesses a task from a title or creation time', () => {
    const first = task('first', { createdAt: 1, soloChat: { sessionId: 'native-first', titleIncludes: 'same title' }, result: { question: `运行 ${command}？` } });
    const newer = task('newer', { createdAt: 2, soloChat: { sessionId: 'native-newer', titleIncludes: 'same title' }, result: { question: `运行 ${command}？` } });
    const f = fixture([first, newer]);
    try {
      assert.deepStrictEqual(f.resume(null, { title: 'same title' }), []);
      assert.deepStrictEqual(f.resume('first', {}), []);
      assert.strictEqual(f.calls.persist, 0);
    } finally { f.close(); }
  });

  r.test('ambiguous legacy candidates require an exact task ID', () => {
    const first = task('first', { createdAt: 1, result: { question: `运行 ${command}？` } });
    const newer = task('newer', { createdAt: 2, result: { question: `运行 ${command}？` } });
    const f = fixture([first, newer]);
    try {
      assert.deepStrictEqual(f.resume(), []);
      assert.deepStrictEqual(f.resume('missing'), []);
      assert.deepStrictEqual(f.resume('first'), ['first']);
      assert.strictEqual(newer.status, 'approval_required');
    } finally { f.close(); }
  });

  for (const [name, expected, actual] of [
    ['quoted path internal whitespace', "node '/tmp/a   b'", "node '/tmp/a b'"],
    ['complete semicolon command', 'npm test; echo ready', 'npm test'],
    ['quoted semicolon suffix', "echo 'a;b'; echo ready", "echo 'a;b'"],
    ['internal newline', 'printf one\nprintf two', 'printf one printf two']
  ]) {
    await r.asyncTest(`HTTP approval rejects ${name} mismatch before clicking`, async () => {
      const f = fixture([]);
      f.gateway.driver.checkForApprovalDialog = async () => ({ ...dialog, command: actual });
      try {
        const res = {};
        await handleResolveInteraction(request(approvalBody(expected)), res, f.gateway);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.error, 'approval_command_mismatch');
        assert.strictEqual(f.calls.decisions.length, 0);
        assert.strictEqual(f.gateway.uiActionInFlight, 0);
      } finally { f.close(); }
    });
  }

  await r.asyncTest('global command approval reads native identity under the UI lock and forwards the full command to the driver', async () => {
    const current = task('current', { createdAt: 1, soloChat: { sessionId: 'native-current' } });
    const newer = task('newer', { createdAt: 2, soloChat: { sessionId: 'native-newer' } });
    const f = fixture([current, newer]);
    f.active('native-current');
    try {
      const res = {};
      await handleResolveInteraction(request(approvalBody()), res, f.gateway);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.resumedTaskIds, ['current']);
      assert.deepStrictEqual(f.calls.decisions, [{ action: 'approve', options: { expectedCommand: command } }]);
      assert.strictEqual(f.calls.activeReads, 1);
      assert.strictEqual(newer.status, 'approval_required');
      assert.strictEqual(f.gateway.uiActionInFlight, 0);
    } finally { f.close(); }
  });

  await r.asyncTest('global decision can resolve an untracked native card without resuming another session task', async () => {
    const owned = task('tracked', { soloChat: { sessionId: 'native-tracked' } });
    const f = fixture([owned]);
    f.active('native-untracked');
    try {
      const res = {};
      await handleResolveInteraction(request({ action: 'deny' }), res, f.gateway);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.resumedTaskIds, []);
      assert.strictEqual(f.calls.decisions.length, 1);
      assert.strictEqual(owned.status, 'approval_required');
    } finally { f.close(); }
  });

  for (const activeSessionId of [null, 'native-other']) {
    await r.asyncTest(`task decision rejects ${activeSessionId || 'missing'} native identity before clicking`, async () => {
      const owned = task('task-bound', { soloChat: { sessionId: 'native-task' } });
      const f = fixture([owned]);
      f.active(activeSessionId);
      try {
        const res = {};
        await handleTaskInteraction(request({ ...approvalBody(), interactionRequestId: owned.interactionRequestId }), res, f.gateway, owned.taskId);
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.error, 'task_interaction_conflict');
        assert.strictEqual(f.calls.decisions.length, 0);
        assert.strictEqual(owned.status, 'approval_required');
        assert.strictEqual(f.gateway.uiActionInFlight, 0);
      } finally { f.close(); }
    });
  }

  await r.asyncTest('task decision verifies its stored command without collapsing quoted-path spaces', async () => {
    const owned = task('task-bound', { result: { dialogType: 'command_execution', command: "node '/tmp/a   b'" } });
    const f = fixture([owned]);
    f.gateway.driver.checkForApprovalDialog = async () => ({ ...dialog, command: "node '/tmp/a b'" });
    try {
      const res = {};
      await handleTaskInteraction(request({ ...approvalBody("node '/tmp/a b'"), interactionRequestId: owned.interactionRequestId }), res, f.gateway, owned.taskId);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'task_interaction_conflict');
      assert.strictEqual(f.calls.decisions.length, 0);
      assert.strictEqual(owned.status, 'approval_required');
    } finally { f.close(); }
  });

  await r.asyncTest('task-bound approval resumes only its exact native task ID and the driver failure leaves it paused', async () => {
    const current = task('current', { soloChat: { sessionId: 'native-current' } });
    const sameSession = task('same-session', { soloChat: { sessionId: 'native-current' } });
    const f = fixture([current, sameSession]);
    f.active('native-current');
    try {
      f.gateway.driver.approveDialog = async (_action, options) => {
        f.calls.decisions.push({ action: 'approve', options });
        return { success: false, error: 'approval_command_mismatch' };
      };
      const failed = {};
      const body = { ...approvalBody(), interactionRequestId: current.interactionRequestId };
      await handleTaskInteraction(request(body), failed, f.gateway, current.taskId);
      assert.strictEqual(failed.status, 409);
      assert.strictEqual(current.status, 'approval_required');
      assert.strictEqual(f.calls.persist, 0);
      f.gateway.driver.approveDialog = async (action, options) => {
        f.calls.decisions.push({ action, options }); return { success: true };
      };
      const res = {};
      await handleTaskInteraction(request(body), res, f.gateway, current.taskId);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.resumedTaskIds, ['current']);
      assert.strictEqual(sameSession.status, 'approval_required');
      assert.ok(f.calls.decisions.every(decision => decision.options?.expectedCommand === command));
      assert.strictEqual(f.calls.activeReads, 2);
    } finally { f.close(); }
  });

  await r.asyncTest('native task-bound question is rejected before answering a different active session', async () => {
    const owned = task('question', { soloChat: { sessionId: 'native-question' }, result: {
      dialogType: 'question', question: 'Choose scope', options: ['Code only']
    } });
    const f = fixture([owned]);
    f.active('native-other');
    f.gateway.driver.checkForApprovalDialog = async () => ({ needsApproval: true, dialogType: 'question', question: 'Choose scope' });
    try {
      const res = {};
      await handleTaskInteraction(request({ action: 'answer', answer: 'Code only', interactionRequestId: owned.interactionRequestId }), res, f.gateway, owned.taskId);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(f.calls.answer, 0);
      assert.strictEqual(owned.status, 'approval_required');
    } finally { f.close(); }
  });

  for (const question of ['What would you like me to review?', 'Select a different review scope']) {
    await r.asyncTest(`global answer resumes only the current native review task while another question is ${question}`, async () => {
      const current = task('current-question', { soloChat: { sessionId: 'native-current' }, result: {
        dialogType: 'review_scope_question', question: 'What would you like me to review?', text: 'Retained review context'
      } });
      const other = task('other-question', { soloChat: { sessionId: 'native-other' }, result: { dialogType: 'review_scope_question', question } });
      const f = fixture([current, other]);
      f.active('native-current');
      try {
        const res = {};
        await handleResolveInteraction(request({ action: 'answer', answer: 'Code only' }), res, f.gateway);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.resumedTaskIds, [current.taskId]);
        assert.strictEqual(f.calls.activeReads, 1);
        assert.strictEqual(current.status, 'executing');
        assert.strictEqual(current.result.text, 'Retained review context');
        assert.strictEqual(other.status, 'approval_required');
        assert.strictEqual(other.interactionRequestId, 'other-question-interaction');
        const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'queue.json'), 'utf8')).tasks;
        assert.strictEqual(stored.find(item => item.taskId === other.taskId).status, 'approval_required');
        assert.strictEqual(f.history.getTask(current.taskId).steps.filter(step => step.action === 'dialog_answered').length, 1);
        assert.strictEqual(f.history.getTask(other.taskId).steps.length, 0);
        assert.strictEqual(f.gateway.uiActionInFlight, 0);
      } finally { f.close(); }
    });
  }

  r.test('legacy answers require a unique review-scope task or its exact task ID', () => {
    const current = task('current-question', { result: { dialogType: 'review_scope_question', question: 'Choose review scope' } });
    const other = task('other-question', { result: { dialogType: 'review_scope_question', question: 'Choose another scope' } });
    const f = fixture([current, other]);
    try {
      assert.deepStrictEqual(f.gateway._resumeApprovalRequiredTasksAfterDialogAnswer('Code only', { success: true }), []);
      assert.strictEqual(current.status, 'approval_required');
      assert.strictEqual(other.status, 'approval_required');
      assert.deepStrictEqual(f.gateway._resumeApprovalRequiredTasksAfterDialogAnswer('Code only', { success: true }, current.taskId), [current.taskId]);
      assert.strictEqual(other.status, 'approval_required');
    } finally { f.close(); }
  });

  r.test('review-scope answer skips persistence-pending, non-review and unbound native candidates', () => {
    const pending = task('pending-question', { cancelPersistencePending: { previousStatus: 'approval_required' },
      result: { dialogType: 'review_scope_question', question: 'Choose review scope' } });
    const commandTask = task('command');
    const bound = task('bound-question', { soloChat: { sessionId: 'native-bound' },
      result: { dialogType: 'review_scope_question', question: 'Choose review scope' } });
    const f = fixture([pending, commandTask, bound]);
    try {
      assert.deepStrictEqual(f.gateway._resumeApprovalRequiredTasksAfterDialogAnswer('Code only', { success: true }), []);
      assert.strictEqual(f.calls.persist + f.calls.poll, 0);
      assert.strictEqual(commandTask.status, 'approval_required');
    } finally { f.close(); }
  });

  r.summary();
  if (r.failed > 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
