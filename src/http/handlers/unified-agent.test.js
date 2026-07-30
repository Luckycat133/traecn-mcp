'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const { handleSubmit, handleListConversations } = require('./unified-agent');
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
      listSoloChats: async () => ({
        mode: 'solo',
        chats: [{ index: 2, title: 'Review API', active: true }],
        count: 1
      })
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

  const listRes = {};
  await handleListConversations(request({}), listRes, ctx);
  assert.deepStrictEqual(listRes.body, {
    mode: 'solo',
    conversations: [{ id: 'solo:UmV2aWV3IEFQSQ', title: 'Review API', active: true }]
  });

  const spec = generateOpenAPISpec();
  assert.ok(spec.paths['/api/tasks/submit']?.post);
  assert.ok(spec.paths['/api/conversations']?.get);
  assert.ok(spec.paths['/api/conversations/manage']?.post);
  assert.ok(spec.paths['/api/interactions/resolve']?.post);

  console.log('[unified-agent.test.js] PASS');
})().catch(error => {
  console.error('[unified-agent.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
