'use strict';

const assert = require('assert');
const { MCP_TOOLS, createMcpHandlers, callTool } = require('./mcp-server');
const { ApiKeyManager } = require('./src/shared/api-key-manager');
const mcpAuth = require('./src/shared/mcp-auth');

process.env.TRAECN_API_KEYS_ENABLED = '1';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

(async () => {
  console.log('\n[mcp-server.test.js] Running tests...\n');

  await test('MCP tools include core and review tools', () => {
    const names = MCP_TOOLS.map(tool => tool.name);
    assert.ok(names.includes('traecn_capabilities'));
    assert.ok(names.includes('plan_operation'));
    assert.ok(names.includes('preflight'));
    assert.ok(names.includes('run_task'));
    assert.ok(names.includes('queue_task'));
    assert.ok(names.includes('wait_task'));
    assert.ok(names.includes('adopt_current_task'));
    assert.ok(names.includes('cancel_task'));
    assert.ok(names.includes('stop_generation'));
    assert.ok(names.includes('dismiss_dialog'));
    assert.ok(names.includes('restart_trae_debug'));
    assert.ok(names.includes('review_gate_status'));
    assert.ok(names.includes('resolve_review_gate'));
    assert.ok(names.includes('review_code'));
    assert.ok(names.includes('vibe_workflow'));
    assert.ok(names.includes('list_solo_chats'));
    assert.ok(names.includes('switch_solo_chat'));
    assert.ok(names.includes('submit_solo_chat_task'));
    assert.ok(names.includes('traecn_command'));
  });

  await test('MCP tool names are unique for reliable agent discovery', () => {
    const names = MCP_TOOLS.map(tool => tool.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  await test('initialize returns server capabilities', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.strictEqual(result.serverInfo.name, 'traecnclaw');
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.prompts);
    assert.ok(result.capabilities.resources);
  });

  await test('tools/list returns MCP tool schemas', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'tools/list' });
    assert.ok(Array.isArray(result.tools));
    const runTask = result.tools.find(tool => tool.name === 'run_task');
    assert.deepStrictEqual(runTask.inputSchema.required, ['task']);
    const switchSoloChat = result.tools.find(tool => tool.name === 'switch_solo_chat');
    assert.ok(switchSoloChat);
    assert.ok(switchSoloChat.inputSchema.properties.index);
    assert.ok(switchSoloChat.inputSchema.properties.titleIncludes);
    assert.ok(switchSoloChat.inputSchema.properties.textIncludes);
    const submitSolo = result.tools.find(tool => tool.name === 'submit_solo_chat_task');
    assert.ok(submitSolo);
    assert.deepStrictEqual(submitSolo.inputSchema.required, ['task']);
    assert.ok(submitSolo.inputSchema.properties.soloChat);
  });

  await test('MCP workflow tools expose completion checks', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'tools/list' });
    const tools = Object.fromEntries(result.tools.map(tool => [tool.name, tool]));

    assert.ok(tools.run_task.inputSchema.properties.completionChecks);
    assert.ok(tools.queue_task.inputSchema.properties.completionChecks);
    assert.ok(tools.wait_task.inputSchema.properties.pollMs);
    assert.ok(tools.adopt_current_task.inputSchema.properties.completionChecks);
    assert.ok(tools.review_code.inputSchema.properties.completionChecks);
    assert.ok(tools.vibe_workflow.inputSchema.properties.completionChecks);
    assert.ok(tools.vibe_workflow.inputSchema.properties.steps.items.anyOf);
    assert.ok(tools.vibe_workflow.inputSchema.properties.followupTasks.items.anyOf);
  });

  await test('prompts and resources proxy prompt layer helpers', async () => {
    const handlers = createMcpHandlers({ test: true });
    const prompts = await handlers.handle({ method: 'prompts/list' });
    assert.ok(prompts.prompts.some(prompt => prompt.name === 'traecn_layered_command'));
    const resources = await handlers.handle({ method: 'resources/list' });
    assert.ok(resources.resources.some(resource => resource.uri === 'traecn://commands/catalog'));
  });

  await test('tools/call handles command catalog without gateway access', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_command_set', arguments: {} }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.ok(payload.commands.some(command => command.command === 'review_code'));
  });

  await test('tools/call returns compact capabilities without gateway access', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_capabilities', arguments: {} }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.name, 'traecnclaw');
    assert.ok(payload.commands.some(command => command.command === 'delegate_async'));
    assert.ok(payload.commands.some(command => command.command === 'vibe_workflow'));
    assert.ok(payload.commands.some(command => command.command === 'list_solo_chats'));
    assert.ok(payload.commands.some(command => command.command === 'switch_solo_chat'));
    assert.ok(payload.commands.some(command => command.command === 'submit_solo_chat_task'));
    assert.ok(payload.mcp.tools.some(tool => tool.name === 'traecn_capabilities'));
    assert.ok(payload.mcp.tools.some(tool => tool.name === 'vibe_workflow'));
    assert.ok(payload.mcp.tools.some(tool => tool.name === 'list_solo_chats'));
    assert.ok(payload.mcp.tools.some(tool => tool.name === 'submit_solo_chat_task'));
  });

  await test('tools/call returns operation confirmation plan without gateway access', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({
      method: 'tools/call',
      params: {
        name: 'plan_operation',
        arguments: { command: 'approve_dialog', params: { action: 'trust' } }
      }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.risk, 'high');
    assert.strictEqual(payload.requiresConfirmation, true);
    assert.ok(payload.recommendedFlow.includes('check_dialog'));
  });

  // ── MCP tool authorization (Batch C2) ────────────────────────────────────

  await test('MCP tools/call allows calls when auth layer is disabled', async () => {
    const handlers = createMcpHandlers({ test: true }, {
      apiKeyManager: { enabled: false }
    });
    const result = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_command_set', arguments: {} }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.ok(payload.commands.some(c => c.command === 'review_code'));
  });

  await test('MCP tools/call rejects calls with no keyId when auth is enabled', async () => {
    const manager = new ApiKeyManager({ enabled: true });
    const handlers = createMcpHandlers({ test: true }, {
      apiKeyManager: manager,
      keyId: null
    });
    const result = await handlers.handle({
      method: 'tools/call',
      params: { name: 'check_status', arguments: {} }
    });
    assert.strictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.code, 'MCP_AUTH_REQUIRED');
  });

  await test('MCP tools/call rejects when key lacks required permission', async () => {
    const manager = new ApiKeyManager({ enabled: true });
    const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
    const handlers = createMcpHandlers({ test: true }, {
      apiKeyManager: manager,
      keyId
    });
    const result = await handlers.handle({
      method: 'tools/call',
      params: { name: 'run_task', arguments: { task: 'review repo' } }
    });
    assert.strictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.code, 'MCP_AUTH_DENIED');
    assert.strictEqual(payload.required, 'delegate');
  });

  await test('MCP tools/call accepts read key on read tool', async () => {
    const manager = new ApiKeyManager({ enabled: true });
    const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
    const handlers = createMcpHandlers({ test: true }, {
      apiKeyManager: manager,
      keyId
    });
    const result = await handlers.handle({
      method: 'tools/call',
      params: { name: 'check_status', arguments: {} }
    });
    // check_status still attempts to reach the gateway; the relevant
    // assertion is that it did NOT short-circuit with an auth error.
    const text = result.content[0].text;
    assert.ok(!text.includes('MCP_AUTH_REQUIRED'));
    assert.ok(!text.includes('MCP_AUTH_DENIED'));
  });

  await test('MCP tools/call honors traecn_command permission from arguments', async () => {
    const manager = new ApiKeyManager({ enabled: true });
    const { keyId } = manager.createKey({ name: 'writer', permissions: ['read', 'write'] });
    const handlers = createMcpHandlers({ test: true }, {
      apiKeyManager: manager,
      keyId
    });

    // read+write is enough for the read-prefixed 'status' command.
    const ok = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_command', arguments: { command: 'status' } }
    });
    assert.ok(!ok.isError || !ok.content[0].text.includes('MCP_AUTH_DENIED'));

    // read+write is not enough for a delegate command.
    const denied = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_command', arguments: { command: 'open_project' } }
    });
    assert.strictEqual(denied.isError, true);
    const payload = JSON.parse(denied.content[0].text);
    assert.strictEqual(payload.code, 'MCP_AUTH_DENIED');
  });

  await test('mcp-auth module is exported from mcp-server', () => {
    const mcpServer = require('./mcp-server');
    assert.ok(mcpServer.mcpAuth);
    assert.strictEqual(typeof mcpServer.mcpAuth.authorizeTool, 'function');
  });

  console.log(`\n[mcp-server.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('[mcp-server.test.js] Fatal error:', err);
  process.exit(1);
});
