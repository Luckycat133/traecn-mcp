'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  McpStdioDecoder,
  TaskEventPump,
  TaskSubscriptionPump,
  encodeMessage,
  nextProtocolEra,
  startStdioServer,
  subscriptionAcknowledgedNotification,
  taskEventNotification,
  stableMcpClientId
} = require('./stdio-server');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('stdio-server.test.js');
const { test, pendingAsyncTests, summary } = runner;

test('stableMcpClientId prefers the configured IDE identity', () => {
  assert.strictEqual(stableMcpClientId({ name: 'Codex Desktop' }, { TRAECN_MCP_CLIENT_ID: 'codex-main' }), 'codex-main');
  assert.strictEqual(stableMcpClientId({ name: 'Codex Desktop' }, {}), 'codex-desktop');
  assert.strictEqual(stableMcpClientId({}, {}), 'traecn-mcp-client');
});

test('stdio uses newline-delimited JSON by default', () => {
  const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, result: {} });
  assert.strictEqual(encoded, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
});

test('stdio decoder accepts chunked newline-delimited MCP messages', () => {
  const decoder = new McpStdioDecoder();
  assert.deepStrictEqual(decoder.push('{"jsonrpc":"2.0","id":1,'), []);
  assert.deepStrictEqual(decoder.push('"method":"tools/list"}\n'), [{
    framing: 'newline',
    message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  }]);
});

test('stdio decoder preserves compatibility with legacy Content-Length framing', () => {
  const decoder = new McpStdioDecoder();
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' });
  assert.deepStrictEqual(decoder.push(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`), [{
    framing: 'content-length',
    message: { jsonrpc: '2.0', id: 2, method: 'initialize' }
  }]);
  assert.ok(encodeMessage({ jsonrpc: '2.0', id: 2, result: {} }, 'content-length').startsWith('Content-Length: '));
});

test('stdio selects one protocol era and rejects missing modern metadata', () => {
  const modern = {
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    }
  };
  assert.strictEqual(nextProtocolEra(null, modern), 'modern');
  assert.strictEqual(nextProtocolEra(null, { method: 'initialize', params: {} }), 'legacy');
  assert.throws(() => nextProtocolEra(null, { method: 'tools/list', params: {} }), /initialize or modern metadata/);
  assert.throws(() => nextProtocolEra('modern', { method: 'tools/list', params: {} }), /Modern MCP requests require/);
  assert.throws(() => nextProtocolEra('legacy', modern), /cannot switch protocol era/);
});

test('taskEventNotification emits a compact standard MCP logging notification', () => {
  const notification = taskEventNotification({
    eventId: 'evt_2',
    taskId: 'task_1',
    status: 'approval_required',
    attentionRequired: true,
    resultAvailable: false,
    summary: 'Approve the command'
  });
  assert.deepStrictEqual(notification, {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: 'warning',
      logger: 'traecnclaw.tasks',
      data: {
        kind: 'traecn_task_event',
        eventId: 'evt_2',
        taskId: 'task_1',
        status: 'approval_required',
        attentionRequired: true,
        resultAvailable: false,
        summary: 'Approve the command'
      }
    }
  });
});

test('TaskEventPump writes before acknowledging and resumes after the last event', async () => {
  const calls = [];
  const client = {
    async listTaskEvents(clientId, options) {
      calls.push(['list', clientId, options]);
      return { data: { events: [{ eventId: 'evt_8', taskId: 'task_4', status: 'completed', resultAvailable: true }] } };
    },
    async ackTaskEvent(clientId, eventId) {
      calls.push(['ack', clientId, eventId]);
      return { data: { acknowledged: true } };
    }
  };
  const pump = new TaskEventPump({
    client,
    clientId: 'codex-main',
    write: message => calls.push(['write', message.params.data.eventId]),
    waitMs: 25000
  });

  const delivered = await pump.pollOnce();
  assert.strictEqual(delivered, 1);
  assert.strictEqual(pump.cursor, 'evt_8');
  assert.deepStrictEqual(calls, [
    ['list', 'codex-main', { limit: 20, waitMs: 25000 }],
    ['write', 'evt_8'],
    ['ack', 'codex-main', 'evt_8']
  ]);
});

test('TaskEventPump does not acknowledge when the transport write fails', async () => {
  let acknowledged = false;
  const pump = new TaskEventPump({
    client: {
      async listTaskEvents() {
        return { data: { events: [{ eventId: 'evt_9', taskId: 'task_5', status: 'error' }] } };
      },
      async ackTaskEvent() {
        acknowledged = true;
      }
    },
    clientId: 'codex-main',
    write: () => { throw new Error('stdout closed'); }
  });

  await assert.rejects(() => pump.pollOnce(), /stdout closed/);
  assert.strictEqual(acknowledged, false);
  assert.strictEqual(pump.cursor, null);
});

test('modern task subscription acknowledgement is correlated to the listen request', () => {
  assert.deepStrictEqual(subscriptionAcknowledgedNotification(
    ['task-1', 'task-2'],
    'listen-3'
  ), {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      notifications: { taskIds: ['task-1', 'task-2'] },
      _meta: { 'io.modelcontextprotocol/subscriptionId': 'listen-3' }
    }
  });
});

test('TaskSubscriptionPump never emits another task result', async () => {
  const calls = [];
  const client = {
    async listTaskEvents(clientId, options) {
      calls.push(['list', clientId, options]);
      return { data: { events: [
        { eventId: 'evt_20', taskId: 'task-foreign', status: 'done' },
        { eventId: 'evt_21', taskId: 'task-owned', status: 'done' }
      ] } };
    },
    async ackTaskEvent(clientId, eventId) {
      calls.push(['ack', clientId, eventId]);
      return { data: { acknowledged: true } };
    }
  };
  const pump = new TaskSubscriptionPump({
    client,
    taskAdapter: {
      async get(taskId) {
        calls.push(['get', taskId]);
        return {
          taskId,
          status: 'completed',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastUpdatedAt: '2026-08-01T00:01:00.000Z',
          ttlMs: 604800000,
          result: { content: [{ type: 'text', text: `${taskId} result` }], isError: false }
        };
      }
    },
    clientId: 'modern-client:listen-8',
    subscriptionId: 'listen-8',
    taskIds: ['task-owned'],
    write(message) {
      calls.push(['write', message.params.taskId, message.params.result.content[0].text]);
    },
    waitMs: 25000
  });

  const delivered = await pump.pollOnce();
  assert.strictEqual(delivered, 1);
  assert.deepStrictEqual(calls, [
    ['list', 'modern-client:listen-8', { limit: 20, waitMs: 25000 }],
    ['ack', 'modern-client:listen-8', 'evt_20'],
    ['get', 'task-owned'],
    ['write', 'task-owned', 'task-owned result'],
    ['ack', 'modern-client:listen-8', 'evt_21']
  ]);
});

test('stdio opens and cancels a correlated modern task subscription', async () => {
  const input = new EventEmitter();
  const writes = [];
  let pumpOptions = null;
  let stopped = false;
  const taskMeta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: { 'io.modelcontextprotocol/tasks': {} }
    },
    'io.modelcontextprotocol/clientInfo': { name: 'Modern Host', version: '1.0.0' }
  };
  const server = startStdioServer({
    input,
    handlers: {
      subscribe(request) {
        assert.strictEqual(request.id, 'listen-stdio-1');
        return { taskIds: ['task-owned'] };
      },
      async handle() {
        return undefined;
      }
    },
    write(message) {
      writes.push(message);
    },
    clientFactory() {
      return { kind: 'gateway-client' };
    },
    taskSubscriptionPumpFactory(options) {
      pumpOptions = options;
      return {
        start() {},
        stop() { stopped = true; }
      };
    }
  });

  input.emit('data', Buffer.from(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'listen-stdio-1',
    method: 'subscriptions/listen',
    params: { notifications: { taskIds: ['task-owned'] }, _meta: taskMeta }
  })}\n`));
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(writes[0].method, 'notifications/subscriptions/acknowledged');
  assert.strictEqual(writes[0].params._meta['io.modelcontextprotocol/subscriptionId'], 'listen-stdio-1');
  assert.deepStrictEqual(pumpOptions.taskIds, ['task-owned']);
  assert.strictEqual(pumpOptions.subscriptionId, 'listen-stdio-1');
  assert.match(pumpOptions.clientId, /^modern-host:task-sub:/);

  input.emit('data', Buffer.from(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'listen-stdio-1', _meta: taskMeta }
  })}\n`));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(stopped, true);
  server.stop();
});

test('stdio closes a live subscription with the standard graceful result', async () => {
  const input = new EventEmitter();
  const writes = [];
  const taskMeta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: { 'io.modelcontextprotocol/tasks': {} }
    },
    'io.modelcontextprotocol/clientInfo': { name: 'Modern Host', version: '1.0.0' }
  };
  const server = startStdioServer({
    input,
    handlers: {
      subscribe() { return { taskIds: ['task-owned'] }; },
      async handle() { return undefined; }
    },
    write(message) { writes.push(message); },
    clientFactory() { return {}; },
    taskSubscriptionPumpFactory() {
      return { start() {}, stop() {} };
    }
  });

  input.emit('data', Buffer.from(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'listen-graceful-1',
    method: 'subscriptions/listen',
    params: { notifications: { taskIds: ['task-owned'] }, _meta: taskMeta }
  })}\n`));
  await new Promise(resolve => setImmediate(resolve));
  await server.stop();

  assert.strictEqual(writes.length, 2);
  assert.deepStrictEqual(writes[1], {
    jsonrpc: '2.0',
    id: 'listen-graceful-1',
    result: {
      resultType: 'complete',
      _meta: {
        'io.modelcontextprotocol/subscriptionId': 'listen-graceful-1',
        'io.modelcontextprotocol/serverInfo': {
          name: 'traecnclaw',
          version: require('../../package.json').version
        }
      }
    }
  });
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})();
