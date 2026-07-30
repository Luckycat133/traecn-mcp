'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const {
  handleSubmit,
  handleListModels,
  handleListConversations,
  handleManageConversation
} = require('./unified-agent');
const { generateOpenAPISpec } = require('../openapi');

function request(body) {
  return Readable.from([Buffer.from(JSON.stringify(body))]);
}

(async () => {
  const calls = [];
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
    _syncTaskHistoryMirror: () => {},
    _persistActiveQueue: () => {},
    driver: {
      detectMode: async () => ({ mode: 'solo' }),
      listModels: async () => ({ current: 'GLM-5.2', models: ['GLM-5.2', 'DeepSeek-V3.2'] }),
      listSoloChats: async () => ({
        mode: 'solo',
        chats: [{ index: 2, title: 'Review API', active: true }],
        count: 1
      }),
      deleteSoloChats: async input => {
        calls.push(['delete', input]);
        return { deleted: 1 };
      }
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
    conversations: [{ id: 'solo:UmV2aWV3IEFQSQ', title: 'Review API', active: true }]
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
    conversationId: 'solo:UmV2aWV3IEFQSQ'
  }), deleteRes, ctx);
  assert.deepStrictEqual(deleteRes.body, {
    action: 'delete',
    conversationId: 'solo:UmV2aWV3IEFQSQ',
    deleted: 1
  });
  assert.deepStrictEqual(calls.at(-1), ['delete', {
    candidates: [{ index: 2, title: 'Review API' }]
  }]);

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
