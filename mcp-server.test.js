'use strict';

const assert = require('assert');
const {
  DEFAULT_MCP_TOOL_PROFILE,
  MCP_TOOLS,
  createMcpHandlers,
  callTool,
  getMcpToolsForProfile,
  normalizeMcpToolProfile
} = require('./mcp-server');
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
    assert.ok(names.includes('traecn_get_capabilities'));
    assert.ok(names.includes('traecn_plan_operation'));
    assert.ok(names.includes('traecn_preflight'));
    assert.ok(names.includes('traecn_run_task'));
    assert.ok(names.includes('traecn_queue_task'));
    assert.ok(names.includes('traecn_wait_task'));
    assert.ok(names.includes('traecn_adopt_current_task'));
    assert.ok(names.includes('traecn_cancel_task'));
    assert.ok(names.includes('traecn_stop_generation'));
    assert.ok(names.includes('traecn_dismiss_dialog'));
    assert.ok(names.includes('traecn_restart_debug_session'));
    assert.ok(names.includes('traecn_get_review_gate_status'));
    assert.ok(names.includes('traecn_resolve_review_gate'));
    assert.ok(names.includes('traecn_review_code'));
    assert.ok(names.includes('traecn_run_unattended_workflow'));
    assert.ok(names.includes('traecn_list_solo_chats'));
    assert.ok(names.includes('traecn_switch_solo_chat'));
    assert.ok(names.includes('traecn_cleanup_queue_probe_chats'));
    assert.ok(names.includes('traecn_get_cleanup_watch_status'));
    assert.ok(names.includes('traecn_start_long_queue_proof'));
    assert.ok(names.includes('traecn_get_long_queue_proof_status'));
    assert.ok(names.includes('traecn_cancel_long_queue_proof'));
    assert.ok(names.includes('traecn_submit_solo_task'));
    assert.ok(names.includes('traecn_run_command'));
  });

  await test('MCP tool names are unique for reliable agent discovery', () => {
    const names = MCP_TOOLS.map(tool => tool.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  await test('MCP tool profiles expose a smaller public surface by default', () => {
    assert.strictEqual(DEFAULT_MCP_TOOL_PROFILE, 'public');
    assert.strictEqual(normalizeMcpToolProfile('unknown'), 'public');

    const publicNames = getMcpToolsForProfile('public').map(tool => tool.name);
    const opsNames = getMcpToolsForProfile('ops').map(tool => tool.name);
    const fullNames = getMcpToolsForProfile('full').map(tool => tool.name);

    assert.ok(publicNames.length < fullNames.length);
    assert.ok(opsNames.length > publicNames.length);
    assert.ok(opsNames.length < fullNames.length);
    assert.ok(publicNames.includes('traecn_get_capabilities'));
    assert.ok(publicNames.includes('traecn_preflight'));
    assert.ok(publicNames.includes('traecn_review_code'));
    assert.ok(publicNames.includes('traecn_run_unattended_workflow'));
    assert.ok(!publicNames.includes('traecn_start_long_queue_proof'));
    assert.ok(!publicNames.includes('traecn_cleanup_queue_probe_chats'));
    assert.ok(opsNames.includes('traecn_start_long_queue_proof'));
    assert.ok(opsNames.includes('traecn_cleanup_queue_probe_chats'));
    assert.ok(!opsNames.includes('traecn_get_status'));
    assert.ok(fullNames.includes('traecn_get_status'));
    assert.strictEqual(fullNames.length, MCP_TOOLS.length);
  });

  await test('initialize returns server capabilities', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.strictEqual(result.serverInfo.name, 'traecnclaw');
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.prompts);
    assert.ok(result.capabilities.resources);
  });

  await test('tools/list uses the public profile by default', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({ method: 'tools/list' });
    const names = result.tools.map(tool => tool.name);
    assert.deepStrictEqual(names, getMcpToolsForProfile('public').map(tool => tool.name));
    assert.ok(names.includes('traecn_run_task'));
    assert.ok(!names.includes('traecn_restart_debug_session'));
    assert.ok(!names.includes('traecn_start_long_queue_proof'));
  });

  await test('tools/list returns MCP tool schemas', async () => {
    const handlers = createMcpHandlers({ test: true }, {}, { toolProfile: 'full' });
    const result = await handlers.handle({ method: 'tools/list' });
    assert.ok(Array.isArray(result.tools));
    const runTask = result.tools.find(tool => tool.name === 'traecn_run_task');
    assert.deepStrictEqual(runTask.inputSchema.required, ['task']);
    const switchSoloChat = result.tools.find(tool => tool.name === 'traecn_switch_solo_chat');
    assert.ok(switchSoloChat);
    assert.ok(switchSoloChat.inputSchema.properties.index);
    assert.ok(switchSoloChat.inputSchema.properties.titleIncludes);
    assert.ok(switchSoloChat.inputSchema.properties.textIncludes);
    const cleanup = result.tools.find(tool => tool.name === 'traecn_cleanup_queue_probe_chats');
    assert.ok(cleanup);
    assert.ok(cleanup.inputSchema.properties.dryRun);
    assert.ok(cleanup.inputSchema.properties.execute);
    const cleanupWatch = result.tools.find(tool => tool.name === 'traecn_get_cleanup_watch_status');
    assert.ok(cleanupWatch);
    assert.ok(cleanupWatch.inputSchema.properties.lockFile);
    const proofStart = result.tools.find(tool => tool.name === 'traecn_start_long_queue_proof');
    assert.ok(proofStart);
    assert.ok(proofStart.inputSchema.properties.execute);
    assert.ok(proofStart.inputSchema.properties.allowQuotaSpend);
    assert.ok(proofStart.inputSchema.properties.detach);
    const proofStatus = result.tools.find(tool => tool.name === 'traecn_get_long_queue_proof_status');
    assert.ok(proofStatus);
    assert.ok(proofStatus.inputSchema.properties.marker);
    const submitSolo = result.tools.find(tool => tool.name === 'traecn_submit_solo_task');
    assert.ok(submitSolo);
    assert.deepStrictEqual(submitSolo.inputSchema.required, ['task']);
    assert.ok(submitSolo.inputSchema.properties.soloChat);
    assert.ok(submitSolo.inputSchema.properties.queueMaxWaitMs);
    const queueTask = result.tools.find(tool => tool.name === 'traecn_queue_task');
    assert.ok(queueTask.inputSchema.properties.sessionId);
    assert.ok(queueTask.inputSchema.properties.soloChat);
    assert.ok(queueTask.inputSchema.properties.soloChatTitleIncludes);
    assert.ok(queueTask.inputSchema.properties.forceBackground);
    assert.ok(queueTask.inputSchema.properties.maxQueueWaitMs);
  });

  await test('MCP workflow tools expose completion checks', async () => {
    const handlers = createMcpHandlers({ test: true }, {}, { toolProfile: 'full' });
    const result = await handlers.handle({ method: 'tools/list' });
    const tools = Object.fromEntries(result.tools.map(tool => [tool.name, tool]));

    assert.ok(tools.traecn_run_task.inputSchema.properties.completionChecks);
    assert.ok(tools.traecn_queue_task.inputSchema.properties.completionChecks);
    assert.ok(tools.traecn_wait_task.inputSchema.properties.pollMs);
    assert.ok(tools.traecn_adopt_current_task.inputSchema.properties.completionChecks);
    assert.ok(tools.traecn_review_code.inputSchema.properties.completionChecks);
    assert.ok(tools.traecn_run_unattended_workflow.inputSchema.properties.completionChecks);
    assert.ok(tools.traecn_run_unattended_workflow.inputSchema.properties.steps.items.anyOf);
    assert.ok(tools.traecn_run_unattended_workflow.inputSchema.properties.followupTasks.items.anyOf);
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
      params: { name: 'traecn_list_commands', arguments: {} }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.ok(payload.commands.some(command => command.command === 'review_code'));
  });

  await test('tools/call returns compact capabilities without gateway access', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_get_capabilities', arguments: {} }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.name, 'traecnclaw');
    assert.strictEqual(payload.mcp.toolProfile, 'public');
    assert.ok(payload.mcp.toolProfiles.public);
    assert.ok(payload.mcp.toolProfiles.ops);
    assert.ok(payload.mcp.toolProfiles.full);
    assert.ok(payload.commands.some(command => command.command === 'delegate_async'));
    assert.ok(payload.commands.some(command => command.command === 'vibe_workflow'));
    assert.ok(payload.commands.some(command => command.command === 'list_solo_chats'));
    assert.ok(payload.commands.some(command => command.command === 'switch_solo_chat'));
    assert.ok(payload.commands.some(command => command.command === 'cleanup_foreign_solo_queue'));
    assert.ok(payload.commands.some(command => command.command === 'cleanup_queue_watch_status'));
    assert.ok(payload.commands.some(command => command.command === 'long_queue_proof_start'));
    assert.ok(payload.commands.some(command => command.command === 'long_queue_proof_status'));
    assert.ok(payload.commands.some(command => command.command === 'long_queue_proof_cancel'));
    assert.ok(payload.commands.some(command => command.command === 'submit_solo_chat_task'));
    assert.ok(payload.mcp.tools.some(tool => tool.name === 'traecn_get_capabilities'));
    assert.ok(payload.mcp.tools.some(tool => tool.name === 'traecn_run_unattended_workflow'));
    assert.ok(!payload.mcp.tools.some(tool => tool.name === 'traecn_list_solo_chats'));
    assert.ok(payload.mcp.toolProfiles.ops.tools.includes('traecn_list_solo_chats'));
    assert.ok(!payload.mcp.tools.some(tool => tool.name === 'traecn_cleanup_queue_probe_chats'));
    assert.ok(!payload.mcp.tools.some(tool => tool.name === 'traecn_get_cleanup_watch_status'));
    assert.ok(!payload.mcp.tools.some(tool => tool.name === 'traecn_get_long_queue_proof_status'));
    assert.ok(!payload.mcp.tools.some(tool => tool.name === 'traecn_submit_solo_task'));
    const reviewTool = payload.mcp.tools.find(tool => tool.name === 'traecn_review_code');
    assert.strictEqual(reviewTool.layer, 'review');
    assert.strictEqual(reviewTool.profile, 'public');
    assert.strictEqual(reviewTool.risk, 'delegate');
    assert.ok(reviewTool.annotations);
  });

  await test('tools/call returns operation confirmation plan without gateway access', async () => {
    const handlers = createMcpHandlers({ test: true });
    const result = await handlers.handle({
      method: 'tools/call',
      params: {
        name: 'traecn_plan_operation',
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
      params: { name: 'traecn_list_commands', arguments: {} }
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
      params: { name: 'traecn_get_status', arguments: {} }
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
      params: { name: 'traecn_run_task', arguments: { task: 'review repo' } }
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
      params: { name: 'traecn_get_status', arguments: {} }
    });
    // traecn_get_status still attempts to reach the gateway; the relevant
    // assertion is that it did NOT short-circuit with an auth error.
    const text = result.content[0].text;
    assert.ok(!text.includes('MCP_AUTH_REQUIRED'));
    assert.ok(!text.includes('MCP_AUTH_DENIED'));
  });

  await test('MCP tools/call honors traecn_run_command permission from arguments', async () => {
    const manager = new ApiKeyManager({ enabled: true });
    const { keyId } = manager.createKey({ name: 'writer', permissions: ['read', 'write'] });
    const handlers = createMcpHandlers({ test: true }, {
      apiKeyManager: manager,
      keyId
    });

    // read+write is enough for the read-prefixed 'status' command.
    const ok = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_run_command', arguments: { command: 'status' } }
    });
    assert.ok(!ok.isError || !ok.content[0].text.includes('MCP_AUTH_DENIED'));

    // read+write is not enough for a delegate command.
    const denied = await handlers.handle({
      method: 'tools/call',
      params: { name: 'traecn_run_command', arguments: { command: 'open_project' } }
    });
    assert.strictEqual(denied.isError, true);
    const payload = JSON.parse(denied.content[0].text);
    assert.strictEqual(payload.code, 'MCP_AUTH_DENIED');
  });

  await test('MCP auth treats proof status as read-only and proof start as delegate', () => {
    assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_get_cleanup_watch_status', {}), 'read');
    assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_run_command', { command: 'cleanup_queue_watch_status' }), 'read');
    assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_get_long_queue_proof_status', {}), 'read');
    assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_start_long_queue_proof', {}), 'delegate');
    assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_run_command', { command: 'long_queue_proof_status' }), 'read');
    assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_run_command', { command: 'long_queue_proof_start' }), 'delegate');
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
