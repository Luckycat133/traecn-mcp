'use strict';

const assert = require('assert');
const http = require('http');
const { createMcpHandlers, callTool } = require('../../mcp-server');

const EXPECTED_TOOLS = [
  'traecn_submit',
  'traecn_get_task',
  'traecn_cancel_task',
  'traecn_list_conversations',
  'traecn_manage_conversation',
  'traecn_resolve_interaction'
];

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run({
      host: '127.0.0.1',
      port: server.address().port,
      token: '',
      timeout: 3000
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  const handlers = createMcpHandlers({ test: true });
  const listed = await handlers.handle({ method: 'tools/list' });
  assert.deepStrictEqual(listed.tools.map(tool => tool.name), EXPECTED_TOOLS);

  const submit = listed.tools.find(tool => tool.name === 'traecn_submit');
  assert.deepStrictEqual(submit.inputSchema.required, ['message']);
  assert.ok(submit.inputSchema.properties.model);
  assert.ok(submit.inputSchema.properties.mode);
  assert.ok(submit.inputSchema.properties.workspace);
  assert.ok(submit.inputSchema.properties.conversationId);
  assert.ok(submit.inputSchema.properties.steps);
  assert.ok(!submit.inputSchema.properties.background);
  assert.ok(!submit.inputSchema.properties.waitForQueue);
  assert.ok(!submit.inputSchema.properties.reviewRequired);

  let captured = null;
  await withServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      captured = {
        method: req.method,
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      };
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task_lean_1', status: 'accepted' }));
    });
  }, async context => {
    const result = await callTool('traecn_submit', {
      message: 'Review the current repository',
      model: 'GLM-5.2',
      mode: 'solo',
      workspace: '/tmp/example',
      conversationId: 'chat-7',
      steps: ['Run focused tests']
    }, context);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), {
      taskId: 'task_lean_1',
      status: 'accepted'
    });
  });

  assert.deepStrictEqual(captured, {
    method: 'POST',
    url: '/api/tasks/submit',
    body: {
      message: 'Review the current repository',
      model: 'GLM-5.2',
      mode: 'solo',
      workspace: '/tmp/example',
      conversationId: 'chat-7',
      steps: ['Run focused tests']
    }
  });

  console.log('[lean-surface.test.js] PASS');
})().catch(error => {
  console.error('[lean-surface.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
