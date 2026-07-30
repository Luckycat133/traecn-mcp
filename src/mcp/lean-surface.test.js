'use strict';

const assert = require('assert');
const http = require('http');
const { createMcpHandlers, callTool } = require('../../mcp-server');

const EXPECTED_TOOLS = [
  'traecn_send_message',
  'traecn_get_task',
  'traecn_cancel_task',
  'traecn_open_workspace',
  'traecn_list_models',
  'traecn_select_model',
  'traecn_select_mode',
  'traecn_list_conversations',
  'traecn_create_conversation',
  'traecn_select_conversation',
  'traecn_delete_conversation',
  'traecn_answer_question',
  'traecn_decide_approval'
];

async function withServer(run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      });
      res.writeHead(req.url === '/api/tasks/submit' ? 202 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/tasks/submit'
        ? { taskId: 'task_atomic_1', status: 'accepted' }
        : { success: true }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({
      host: '127.0.0.1',
      port: server.address().port,
      token: '',
      timeout: 3000
    }, requests);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  const handlers = createMcpHandlers({ test: true });
  const listed = await handlers.handle({ method: 'tools/list' });
  assert.deepStrictEqual(listed.tools.map(tool => tool.name), EXPECTED_TOOLS);

  const send = listed.tools.find(tool => tool.name === 'traecn_send_message');
  assert.deepStrictEqual(send.inputSchema.required, ['message']);
  assert.deepStrictEqual(Object.keys(send.inputSchema.properties), ['message', 'conversationId']);

  const modelList = listed.tools.find(tool => tool.name === 'traecn_list_models');
  assert.deepStrictEqual(modelList.inputSchema.required, []);
  assert.deepStrictEqual(Object.keys(modelList.inputSchema.properties), []);

  await withServer(async (context, requests) => {
    const sent = await callTool('traecn_send_message', {
      message: 'Review the repository',
      conversationId: 'solo:UmV2aWV3IEFQSQ'
    }, context);
    assert.deepStrictEqual(JSON.parse(sent.content[0].text), {
      taskId: 'task_atomic_1',
      status: 'accepted'
    });

    await callTool('traecn_open_workspace', { path: '/tmp/repo' }, context);
    await callTool('traecn_list_models', {}, context);
    await callTool('traecn_select_model', { model: 'GLM-5.2' }, context);
    await callTool('traecn_select_mode', { mode: 'solo' }, context);
    await callTool('traecn_create_conversation', {}, context);
    await callTool('traecn_select_conversation', { conversationId: 'solo:chat-a' }, context);
    await callTool('traecn_delete_conversation', { conversationId: 'solo:chat-b' }, context);
    await callTool('traecn_answer_question', { answer: '当前工作区' }, context);
    await callTool('traecn_decide_approval', { decision: 'deny' }, context);

    assert.deepStrictEqual(requests, [
      { method: 'POST', url: '/api/tasks/submit', body: { message: 'Review the repository', conversationId: 'solo:UmV2aWV3IEFQSQ' } },
      { method: 'POST', url: '/api/open-project', body: { projectPath: '/tmp/repo' } },
      { method: 'GET', url: '/api/models', body: null },
      { method: 'POST', url: '/api/switch-model', body: { model: 'GLM-5.2', waitForQueue: false } },
      { method: 'POST', url: '/api/switch-mode', body: { mode: 'solo', allowAutoStart: false } },
      { method: 'POST', url: '/api/conversations/manage', body: { action: 'create' } },
      { method: 'POST', url: '/api/conversations/manage', body: { action: 'select', conversationId: 'solo:chat-a' } },
      { method: 'POST', url: '/api/conversations/manage', body: { action: 'delete', conversationId: 'solo:chat-b' } },
      { method: 'POST', url: '/api/interactions/resolve', body: { action: 'answer', answer: '当前工作区' } },
      { method: 'POST', url: '/api/interactions/resolve', body: { action: 'deny' } }
    ]);
  });

  console.log('[lean-surface.test.js] PASS');
})().catch(error => {
  console.error('[lean-surface.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
