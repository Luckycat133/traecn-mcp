'use strict';

const assert = require('assert');
const http = require('http');
const {
  DEFAULT_MCP_TOOL_PROFILE,
  MCP_TOOLS,
  createMcpHandlers,
  callTool,
  getMcpToolsForProfile,
  normalizeMcpToolProfile,
  mcpAuth
} = require('./mcp-server');
const { ApiKeyManager } = require('./src/shared/api-key-manager');

process.env.TRAECN_API_KEYS_ENABLED = '1';

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

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${error.message}`);
  }
}

(async () => {
  console.log('\n[mcp-server.test.js] Running tests...\n');

  await test('MCP exposes one focused atomic tool surface', async () => {
    assert.strictEqual(DEFAULT_MCP_TOOL_PROFILE, 'default');
    assert.strictEqual(normalizeMcpToolProfile('full'), 'default');
    assert.deepStrictEqual(MCP_TOOLS.map(tool => tool.name), EXPECTED_TOOLS);
    assert.deepStrictEqual(getMcpToolsForProfile('anything').map(tool => tool.name), EXPECTED_TOOLS);
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'tools/list' });
    assert.deepStrictEqual(result.tools.map(tool => tool.name), EXPECTED_TOOLS);
  });

  await test('initialize advertises tools, prompts, resources and logging', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.strictEqual(result.serverInfo.name, 'traecnclaw');
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.prompts);
    assert.ok(result.capabilities.resources);
    assert.ok(result.capabilities.logging);
  });

  await test('get_task forwards one explicit status lookup', async () => {
    let request = null;
    const server = http.createServer((req, res) => {
      request = { method: req.method, url: req.url };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task-1', status: 'done', result: { text: 'complete' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await callTool('traecn_get_task', { taskId: 'task-1' }, {
        host: '127.0.0.1', port: server.address().port, token: '', timeout: 3000
      });
      assert.deepStrictEqual(request, { method: 'GET', url: '/api/task/task-1' });
      assert.strictEqual(JSON.parse(result.content[0].text).status, 'done');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await test('read keys cannot submit and can query tasks', () => {
    const manager = new ApiKeyManager({ enabled: true });
    const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
    assert.strictEqual(mcpAuth.authorizeTool({ apiKeyManager: manager, keyId, toolName: 'traecn_get_task', args: {} }).ok, true);
    const denied = mcpAuth.authorizeTool({ apiKeyManager: manager, keyId, toolName: 'traecn_send_message', args: {} });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.required, 'delegate');
  });

  await test('removed compatibility tools are unknown', async () => {
    await assert.rejects(() => callTool('traecn_run_command', {}), /Unknown tool/);
    await assert.rejects(() => callTool('traecn_preflight', {}), /Unknown tool/);
    await assert.rejects(() => callTool('traecn_run_unattended_workflow', {}), /Unknown tool/);
    await assert.rejects(() => callTool('traecn_submit', {}), /Unknown tool/);
  });

  console.log(`\n[mcp-server.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(error => {
  console.error('[mcp-server.test.js] Fatal error:', error);
  process.exit(1);
});
