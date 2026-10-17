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
    assert.deepStrictEqual(
      result.capabilities.extensions['io.modelcontextprotocol/tasks'],
      {}
    );
    assert.strictEqual(result.cacheScope, 'private');
    assert.ok(result.ttlMs > 0);
  });

  await test('modern task extension creates and retrieves one durable TraeCN task', async () => {
    let taskReads = 0;
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/tasks/submit') {
        res.writeHead(202);
        return res.end(JSON.stringify({ taskId: 'task-ext-1', status: 'accepted' }));
      }
      if (req.method === 'GET' && req.url === '/api/task/task-ext-1') {
        taskReads += 1;
        res.writeHead(200);
        return res.end(JSON.stringify(taskReads === 1
          ? {
            taskId: 'task-ext-1',
            status: 'queued',
            createdAt: 1785542400000,
            message: 'queued by TraeCN'
          }
          : {
            taskId: 'task-ext-1',
            status: 'done',
            createdAt: 1785542400000,
            completedAt: '2026-08-01T00:01:00.000Z',
            result: { text: 'extension result', stable: true }
          }));
      }
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const handlers = createMcpHandlers({
      host: '127.0.0.1', port: server.address().port, token: '', timeout: 3000
    });
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} }
      }
    };
    try {
      const created = await handlers.handle({
        jsonrpc: '2.0',
        id: 'send-1',
        method: 'tools/call',
        params: {
          name: 'traecn_send_message',
          arguments: { message: 'Complete this in the background' },
          _meta: meta
        }
      });
      assert.strictEqual(created.resultType, 'task');
      assert.strictEqual(created.taskId, 'task-ext-1');
      assert.strictEqual(created.status, 'working');
      assert.strictEqual(created._meta['io.modelcontextprotocol/serverInfo'].name, 'traecnclaw');

      const completed = await handlers.handle({
        jsonrpc: '2.0',
        id: 'get-1',
        method: 'tasks/get',
        params: { taskId: 'task-ext-1', _meta: meta }
      });
      assert.strictEqual(completed.resultType, 'complete');
      assert.strictEqual(completed.status, 'completed');
      assert.strictEqual(JSON.parse(completed.result.content[0].text).text, 'extension result');
      assert.deepStrictEqual(JSON.parse(completed.result.content[0].text), completed.result.structuredContent);

      const fallback = await handlers.handle({
        jsonrpc: '2.0',
        id: 'send-without-task-extension',
        method: 'tools/call',
        params: {
          name: 'traecn_send_message',
          arguments: { message: 'Use the compatible result shape' },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      });
      assert.strictEqual(fallback.resultType, 'complete');
      assert.strictEqual(fallback.structuredContent.taskId, 'task-ext-1');

      await assert.rejects(
        () => handlers.handle({
          jsonrpc: '2.0',
          id: 'get-no-capability',
          method: 'tasks/get',
          params: {
            taskId: 'task-ext-1',
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        }),
        error => error.code === -32021
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
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

  await test('MCP rejects malformed arguments before any gateway mutation', async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const handlers = createMcpHandlers({ host: '127.0.0.1', port: server.address().port, timeout: 1000 });
      for (const args of [null, [], 'unexpected', false, 0]) {
        const result = await handlers.handle({
          method: 'tools/call', params: { name: 'traecn_create_conversation', arguments: args }
        });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(result.structuredContent.code, 'INVALID_ARGUMENTS');
      }
      assert.strictEqual(requests, 0);
      for (const name of ['constructor', 'toString', '__proto__']) {
        await assert.rejects(() => handlers.handle({ method: 'tools/call', params: { name } }),
          error => error.code === -32602);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await test('MCP validates capability objects and subscription task identities', async () => {
    const handlers = createMcpHandlers({ test: true });
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} }
      }
    };
    await assert.rejects(() => handlers.handle({
      method: 'tools/list', params: { _meta: { ...metadata, 'io.modelcontextprotocol/clientCapabilities': [] } }
    }), error => error.code === -32602);
    await assert.rejects(() => handlers.handle({
      method: 'tasks/get',
      params: {
        taskId: 'task-1',
        _meta: { ...metadata, 'io.modelcontextprotocol/clientCapabilities': {
          extensions: { 'io.modelcontextprotocol/tasks': [] }
        } }
      }
    }), error => error.code === -32021);
    for (const taskIds of [[1], [null], [{}], [' ']]) {
      assert.throws(() => handlers.subscribe({
        method: 'subscriptions/listen', params: { notifications: { taskIds }, _meta: metadata }
      }), error => error.code === -32602);
    }
    assert.deepStrictEqual(handlers.subscribe({
      method: 'subscriptions/listen', params: { notifications: { taskIds: ['task-1', 'task-1'] }, _meta: metadata }
    }), { taskIds: ['task-1'] });
    await assert.rejects(() => handlers.handle({
      method: 'tasks/get', params: { taskId: 'task-1', _meta: {
        'io.modelcontextprotocol/clientCapabilities': metadata['io.modelcontextprotocol/clientCapabilities']
      } }
    }), error => error.code === -32022);
  });

  await test('MCP authorization failures remain structured and actionable', async () => {
    const manager = new ApiKeyManager({ enabled: true });
    const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
    const result = await callTool('traecn_create_conversation', {}, { test: true }, {
      apiKeyManager: manager, keyId
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.required, 'write');
    assert.strictEqual(result.structuredContent.code, 'MCP_AUTH_DENIED');
    assert.strictEqual(result.structuredContent.retryable, false);
    assert.ok(result.structuredContent.nextAction);
    assert.strictEqual(result.structuredContent.message, result.structuredContent.error);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), result.structuredContent);
  });

  await test('Tasks methods and subscriptions enforce the existing tool permissions', async () => {
    const manager = new ApiKeyManager({ enabled: true });
    const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
    let mutations = 0;
    const taskAdapter = {
      async get(taskId) { return { taskId, status: 'working' }; },
      async update() { mutations++; return {}; },
      async cancel() { mutations++; return {}; }
    };
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} }
      }
    };
    const handlers = createMcpHandlers({ test: true }, { apiKeyManager: manager, keyId, taskAdapter });
    const read = await handlers.handle({ method: 'tasks/get', params: { taskId: 'task-1', _meta: metadata } });
    assert.strictEqual(read.taskId, 'task-1');
    for (const method of ['tasks/update', 'tasks/cancel']) {
      await assert.rejects(() => handlers.handle({
        method, params: { taskId: 'task-1', inputResponses: {}, _meta: metadata }
      }), error => error.data?.code === 'MCP_AUTH_DENIED' && error.data.required === 'delegate');
    }
    assert.strictEqual(mutations, 0);
    const unauthenticated = createMcpHandlers({ test: true }, { apiKeyManager: manager, taskAdapter });
    await assert.rejects(() => unauthenticated.handle({
      method: 'tasks/get', params: { taskId: 'task-1', _meta: metadata }
    }), error => error.data?.code === 'MCP_AUTH_REQUIRED');
    assert.throws(() => unauthenticated.subscribe({
      method: 'subscriptions/listen', params: { notifications: { taskIds: ['task-1'] }, _meta: metadata }
    }), error => error.data?.code === 'MCP_AUTH_REQUIRED');
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

  await test('get_task lets the agent request the full execution trace', async () => {
    let request = null;
    const server = http.createServer((req, res) => {
      request = { method: req.method, url: req.url };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task-1', status: 'done', result: { text: 'trace' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await callTool('traecn_get_task', { taskId: 'task-1', detailLevel: 'trace' }, {
        host: '127.0.0.1', port: server.address().port, token: '', timeout: 3000
      });
      assert.deepStrictEqual(request, {
        method: 'GET',
        url: '/api/task/task-1?detailLevel=trace'
      });
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
