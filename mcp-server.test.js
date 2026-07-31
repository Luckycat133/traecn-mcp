'use strict';

const assert = require('assert');
const http = require('http');
const mcpServer = require('./mcp-server');
const {
  MCP_CONTRACT_VERSION,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  createMcpHandlers,
  callTool,
  mcpAuth
} = mcpServer;
const { ApiKeyManager } = require('./src/shared/api-key-manager');

process.env.TRAECN_API_KEYS_ENABLED = '1';

const EXPECTED_TOOLS = [
  'traecn_send_message',
  'traecn_get_task',
  'traecn_cancel_task',
  'traecn_stop_generation',
  'traecn_open_workspace',
  'traecn_list_models',
  'traecn_select_model',
  'traecn_select_mode',
  'traecn_list_setting_sections',
  'traecn_list_settings',
  'traecn_list_setting_options',
  'traecn_set_setting_toggle',
  'traecn_select_setting_option',
  'traecn_set_setting_text',
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

  await test('MCP contract v5 exposes exactly one 20-tool surface', async () => {
    assert.strictEqual(MCP_CONTRACT_VERSION, 5);
    assert.deepStrictEqual(MCP_TOOL_NAMES, EXPECTED_TOOLS);
    assert.strictEqual(MCP_TOOLS.length, 20);
    assert.deepStrictEqual(MCP_TOOLS.map(tool => tool.name), EXPECTED_TOOLS);
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'tools/list' });
    assert.deepStrictEqual(result.tools.map(tool => tool.name), EXPECTED_TOOLS);
  });

  await test('MCP no longer exports profile compatibility APIs', () => {
    for (const name of [
      'DEFAULT_MCP_TOOL_PROFILE',
      'MCP_TOOL_PROFILES',
      'MCP_TOOL_PROFILE_DESCRIPTIONS',
      'normalizeMcpToolProfile',
      'getMcpToolsForProfile',
      'getMcpToolProfileSummary',
      'envToolProfile'
    ]) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(mcpServer, name), false, name);
    }
  });

  await test('initialize advertises tools, prompts, resources and logging', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    assert.strictEqual(result.protocolVersion, '2025-11-25');
    assert.strictEqual(result.serverInfo.name, 'traecnclaw');
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.prompts);
    assert.ok(result.capabilities.resources);
    assert.ok(result.capabilities.logging);
    const fallback = await handlers.handle({ method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    assert.strictEqual(fallback.protocolVersion, '2025-11-25');
  });

  await test('modern discovery advertises MCP 2026-07-28 without deprecated logging', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    });
    assert.strictEqual(result.resultType, 'complete');
    assert.deepStrictEqual(result.supportedVersions, ['2026-07-28', '2025-11-25', '2024-11-05']);
    assert.strictEqual(result._meta['io.modelcontextprotocol/serverInfo'].name, 'traecnclaw');
    assert.strictEqual(result.capabilities.logging, undefined);
    assert.ok(result.capabilities.tools);
    assert.strictEqual(result.cacheScope, 'private');
    assert.ok(result.ttlMs > 0);
  });

  await test('modern requests require a supported per-request protocol version', async () => {
    const handlers = createMcpHandlers({ test: true });
    await assert.rejects(
      () => handlers.handle({
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2099-01-01',
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      }),
      error => error.code === -32022
        && error.data.requested === '2099-01-01'
        && error.data.supported.includes('2026-07-28')
    );
  });

  await test('modern list results are typed and cacheable', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    });
    assert.strictEqual(result.resultType, 'complete');
    assert.strictEqual(result.cacheScope, 'private');
    assert.ok(result.ttlMs > 0);
    assert.strictEqual(result._meta['io.modelcontextprotocol/serverInfo'].name, 'traecnclaw');
  });

  await test('tool metadata and results expose structured JSON', async () => {
    assert.ok(MCP_TOOLS.every(tool => tool.outputSchema));
    const synthetic = require('./src/mcp/tools').asMcpContent({ ok: true, count: 1 });
    assert.deepStrictEqual(synthetic.structuredContent, { ok: true, count: 1 });
    assert.strictEqual(synthetic.isError, false);
  });

  await test('MCP separates protocol errors from actionable tool errors', async () => {
    const handlers = createMcpHandlers({
      host: '127.0.0.1', port: 1, token: '', timeout: 10
    });
    await assert.rejects(
      () => handlers.handle({ method: 'unknown/method' }),
      error => error.code === -32601
    );
    await assert.rejects(
      () => handlers.handle({ method: 'tools/call', params: { name: 'traecn_missing', arguments: {} } }),
      error => error.code === -32602
    );
    const invalid = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_get_task', arguments: {} }
    });
    assert.strictEqual(invalid.isError, true);
    assert.match(invalid.structuredContent.error, /taskId/);
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
