'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const {
  handleSubmit,
  handleListModels,
  handleListConversations,
  handleManageConversation,
  handleResolveInteraction
} = require('./unified-agent');
const { generateOpenAPISpec } = require('../openapi');

function request(body) {
  return Readable.from([Buffer.from(JSON.stringify(body))]);
}

(async () => {
  const calls = [];
  const auditEntries = [];
  const task = {
    taskId: 'task_gateway_1',
    status: 'queued',
    followupTasks: []
  };
  const ctx = {
    _json: (_req, res, body, status = 200) => {
      res.body = body;
      res.status = status;
      return res;
    },
    _ensureConnection: async () => calls.push('connect'),
    _withUiActionLock: operation => operation(),
    _ensureRequestedWorkspace: async workspace => calls.push(['workspace', workspace]),
    _createQueuedTask: body => {
      calls.push(['queue', body]);
      return task;
    },
    _ensureBackgroundPolling: () => calls.push('poll'),
    _resumeApprovalRequiredTasksAfterInteraction: (action, dialog, result) => {
      calls.push(['resume-interaction', action, dialog.command, result.success]);
      return ['task_gateway_1'];
    },
    _syncTaskHistoryMirror: () => {},
    _persistActiveQueue: () => {},
    driver: {
      detectMode: async () => ({ mode: 'solo' }),
      listModels: async () => ({ current: 'GLM-5.2', models: ['GLM-5.2', 'DeepSeek-V3.2'] }),
      listSoloChats: async () => ({
        mode: 'solo',
        chats: [
          { index: 2, title: 'Review API', active: true },
          { index: 3, title: 'Old review', active: false }
        ],
        count: 2
      }),
      deleteSoloChats: async input => {
        calls.push(['delete', input]);
        return { deleted: 1 };
      },
      checkForApprovalDialog: async () => ({
        needsApproval: true,
        isCommandExec: true,
        approvalDecision: 'agent_review',
        command: 'git push origin main',
        commandRisk: 'high',
        riskReasons: ['git_write_or_remote']
      }),
      approveDialog: async action => ({ success: true, action })
    },
    auditLogger: {
      log: entry => auditEntries.push(entry)
    }
  };

  const res = {};
  await handleSubmit(request({
    message: 'Review the repository',
    model: 'GLM-5.2',
    mode: 'solo',
    workspace: '/tmp/repo',
    conversationId: 'solo:UmV2aWV3IEFQSQ',
    steps: ['Run tests']
  }), res, ctx);

  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(res.body, { taskId: 'task_gateway_1', status: 'accepted' });
  assert.deepStrictEqual(calls[0], 'connect');
  assert.deepStrictEqual(calls[1], ['workspace', '/tmp/repo']);
  assert.deepStrictEqual(calls[2], ['queue', {
    task: 'Review the repository',
    projectPath: '/tmp/repo',
    desiredModel: 'GLM-5.2',
    desiredMode: 'solo',
    soloChat: { titleIncludes: 'Review API' },
    newConversation: false,
    followupTasks: [{ task: 'Run tests', autoContinue: true, reviewRequired: false }],
    autoContinue: true,
    reviewRequired: false,
    autoApproveDialog: 'auto'
  }]);
  assert.strictEqual(calls[3], 'poll');

  calls.length = 0;
  const continueRes = {};
  await handleSubmit(request({ message: 'Continue the current conversation' }), continueRes, ctx);
  assert.strictEqual(calls[1][0], 'queue');
  assert.strictEqual(calls[1][1].newConversation, false);

  const snapshotCalls = [];
  const snapshotCtx = {
    ...ctx,
    _selectedWorkspacePath: '/tmp/selected',
    _assertProjectWorkspace: async path => ({ rootPath: path }),
    _createQueuedTask: body => {
      snapshotCalls.push(body);
      return { ...task, taskId: 'task_snapshot_1' };
    },
    driver: {
      ...ctx.driver,
      detectMode: async () => ({ mode: 'solo' }),
      getCurrentModel: async () => 'GLM-5.2',
      listSoloChats: async () => ({
        chats: [{ index: 2, title: 'Review API', active: true }]
      })
    }
  };
  await handleSubmit(request({ message: 'Bind current context' }), {}, snapshotCtx);
  assert.deepStrictEqual(snapshotCalls[0], {
    task: 'Bind current context',
    projectPath: '/tmp/selected',
    desiredModel: 'GLM-5.2',
    desiredMode: 'solo',
    soloChat: { titleIncludes: 'Review API' },
    newConversation: false,
    followupTasks: [],
    autoContinue: true,
    reviewRequired: false,
    autoApproveDialog: 'auto'
  });

  const listRes = {};
  await handleListConversations(request({}), listRes, ctx);
  assert.deepStrictEqual(listRes.body, {
    mode: 'solo',
    conversations: [
      { id: 'solo:UmV2aWV3IEFQSQ', title: 'Review API', active: true },
      { id: 'solo:T2xkIHJldmlldw', title: 'Old review', active: false }
    ]
  });

  const modelRes = {};
  await handleListModels(request({}), modelRes, ctx);
  assert.deepStrictEqual(modelRes.body, {
    current: 'GLM-5.2',
    models: ['GLM-5.2', 'DeepSeek-V3.2']
  });

  const deleteRes = {};
  await handleManageConversation(request({
    action: 'delete',
    conversationId: 'solo:T2xkIHJldmlldw',
    expectedTitle: 'Old review',
    acknowledgePermanentDeletion: true
  }), deleteRes, ctx);
  assert.deepStrictEqual(deleteRes.body, {
    action: 'delete',
    conversationId: 'solo:T2xkIHJldmlldw',
    deleted: 1,
    recoverable: false
  });
  assert.deepStrictEqual(calls.at(-1), ['delete', {
    candidates: [{ index: 3, title: 'Old review' }]
  }]);
  assert.strictEqual(auditEntries.at(-1).action, 'conversation.delete');

  const activeDeleteRes = {};
  await handleManageConversation(request({
    action: 'delete',
    conversationId: 'solo:UmV2aWV3IEFQSQ',
    expectedTitle: 'Review API',
    acknowledgePermanentDeletion: true
  }), activeDeleteRes, ctx);
  assert.strictEqual(activeDeleteRes.status, 409);
  assert.strictEqual(activeDeleteRes.body.error, 'active_conversation_delete_forbidden');

  const unconfirmedDeleteRes = {};
  await handleManageConversation(request({
    action: 'delete',
    conversationId: 'solo:T2xkIHJldmlldw',
    expectedTitle: 'Old review'
  }), unconfirmedDeleteRes, ctx);
  assert.strictEqual(unconfirmedDeleteRes.status, 400);
  assert.strictEqual(unconfirmedDeleteRes.body.error, 'permanent_deletion_acknowledgement_required');

  const staleApprovalRes = {};
  await handleResolveInteraction(request({
    action: 'approve',
    expectedCommand: 'rm -rf build',
    acknowledgeRisk: true,
    reason: 'User requested cleanup'
  }), staleApprovalRes, ctx);
  assert.strictEqual(staleApprovalRes.status, 409);
  assert.strictEqual(staleApprovalRes.body.error, 'approval_command_mismatch');

  const approvalRes = {};
  await handleResolveInteraction(request({
    action: 'approve',
    expectedCommand: 'git push origin main',
    acknowledgeRisk: true,
    reason: 'User explicitly requested publishing the current branch'
  }), approvalRes, ctx);
  assert.strictEqual(approvalRes.status, 200);
  assert.strictEqual(approvalRes.body.success, true);
  assert.deepStrictEqual(approvalRes.body.resumedTaskIds, ['task_gateway_1']);
  assert.deepStrictEqual(calls.at(-1), [
    'resume-interaction',
    'approve',
    'git push origin main',
    true
  ]);
  assert.strictEqual(auditEntries.at(-1).action, 'interaction.approval_decision');

  const spec = generateOpenAPISpec();
  assert.ok(spec.paths['/api/tasks/submit']?.post);
  assert.ok(spec.paths['/api/models']?.get);
  assert.ok(spec.paths['/api/conversations']?.get);
  assert.ok(spec.paths['/api/conversations/manage']?.post);
  assert.ok(spec.paths['/api/interactions/resolve']?.post);

  console.log('[unified-agent.test.js] PASS');
})().catch(error => {
  console.error('[unified-agent.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
