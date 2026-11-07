'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const http = require('http');
const { TraeCNApiClient } = require('../client/traecnapi-client');
const {
  McpStdioDecoder,
  TaskEventPump,
  TaskSubscriptionPump,
  assertJsonRpcRequest,
  encodeMessage,
  nextProtocolEra,
  startStdioServer,
  subscriptionAcknowledgedNotification,
  subscriptionClosedResult,
  taskEventNotification,
  stableMcpClientId
} = require('./stdio-server');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('stdio-server.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

function subscriptionRequest(id, method = 'subscriptions/listen') {
  return {
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method,
    params: {
      notifications: { taskIds: ['task-owned'] },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { 'io.modelcontextprotocol/tasks': {} }
        }
      }
    }
  };
}

function sendInput(input, request) {
  input.emit('data', Buffer.from(encodeMessage(request)));
  return new Promise(resolve => setImmediate(resolve));
}

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

test('stdio decoder preserves valid frames around a malformed newline payload', () => {
  const frames = new McpStdioDecoder().push('{"id":1}\n{malformed}\n{"id":2}\n');
  assert.strictEqual(frames.length, 3);
  assert.deepStrictEqual(frames[0].message, { id: 1 });
  assert.ok(frames[1].error instanceof SyntaxError);
  assert.strictEqual(frames[1].framing, 'newline');
  assert.deepStrictEqual(frames[2].message, { id: 2 });
});

test('stdio decoder consumes malformed Content-Length JSON before the next frame', () => {
  const decoder = new McpStdioDecoder();
  const malformed = 'Content-Length: 4\r\n\r\n{bad';
  const valid = encodeMessage({ id: 2, text: '中文' }, 'content-length');
  const frames = decoder.push(malformed + valid);
  assert.strictEqual(frames.length, 2);
  assert.ok(frames[0].error instanceof SyntaxError);
  assert.strictEqual(frames[0].framing, 'content-length');
  assert.deepStrictEqual(frames[1].message, { id: 2, text: '中文' });
  assert.deepStrictEqual(decoder.push(''), []);
});

test('stdio decoder recovers from an invalid Content-Length header without losing valid neighbors', () => {
  const frames = new McpStdioDecoder().push(
    encodeMessage({ id: 1 }, 'content-length')
    + 'Content-Length: invalid\r\n\r\n'
    + encodeMessage({ id: 2 }, 'content-length')
  );
  assert.strictEqual(frames.length, 3);
  assert.deepStrictEqual(frames[0].message, { id: 1 });
  assert.ok(frames[1].error instanceof SyntaxError);
  assert.deepStrictEqual(frames[2].message, { id: 2 });
});

test('stdio rejects invalid request ids before dispatch', () => {
  for (const id of [null, true, {}, [], 1.5]) {
    assert.throws(() => assertJsonRpcRequest({ jsonrpc: '2.0', id, method: 'ping' }),
      error => error.code === -32600);
  }
  for (const id of [0, 1, '1']) {
    assert.strictEqual(assertJsonRpcRequest({ jsonrpc: '2.0', id, method: 'ping' }).id, id);
  }
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

test('legacy stdio ignores unrelated request metadata from Codex', () => {
  assert.strictEqual(nextProtocolEra('legacy', {
    method: 'tools/list',
    params: {
      _meta: { progressToken: 1 }
    }
  }), 'legacy');
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

asyncTest('TaskEventPump writes before acknowledging and resumes after the last event', async () => {
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

asyncTest('TaskEventPump baselines retained history for a new MCP client', async () => {
  const calls = [];
  let listCall = 0;
  const client = {
    async listTaskEvents(clientId, options) {
      calls.push(['list', clientId, options]);
      listCall += 1;
      if (listCall === 1) {
        return {
          data: {
            clientKnown: false,
            acknowledgedCursor: null,
            events: [{ eventId: 'evt_40', taskId: 'task-historical', status: 'done' }],
            cursor: 'evt_40',
            hasMore: false
          }
        };
      }
      return {
        data: {
          clientKnown: true,
          acknowledgedCursor: 'evt_40',
          events: [{ eventId: 'evt_41', taskId: 'task-current', status: 'done' }],
          cursor: 'evt_41',
          hasMore: false
        }
      };
    },
    async ackTaskEvent(clientId, eventId) {
      calls.push(['ack', clientId, eventId]);
      return { data: { acknowledged: true } };
    }
  };
  const pump = new TaskEventPump({
    client,
    clientId: 'new-codex-client',
    write: message => calls.push(['write', message.params.data.eventId]),
    waitMs: 25000
  });

  assert.strictEqual(await pump.primeCursor(), 'evt_40');
  assert.strictEqual(await pump.pollOnce(), 1);
  assert.deepStrictEqual(calls, [
    ['list', 'new-codex-client', { limit: 100, waitMs: 0 }],
    ['ack', 'new-codex-client', 'evt_40'],
    ['list', 'new-codex-client', { limit: 20, waitMs: 25000, after: 'evt_40' }],
    ['write', 'evt_41'],
    ['ack', 'new-codex-client', 'evt_41']
  ]);
});

asyncTest('TaskEventPump preserves undelivered events for a returning MCP client', async () => {
  const calls = [];
  const client = {
    async listTaskEvents(clientId, options) {
      calls.push(['list', clientId, options]);
      return {
        data: {
          clientKnown: true,
          acknowledgedCursor: 'evt_50',
          events: [{ eventId: 'evt_51', taskId: 'task-missed', status: 'done' }],
          cursor: 'evt_51',
          hasMore: false
        }
      };
    },
    async ackTaskEvent(clientId, eventId) {
      calls.push(['ack', clientId, eventId]);
      return { data: { acknowledged: true } };
    }
  };
  const pump = new TaskEventPump({
    client,
    clientId: 'returning-codex-client',
    write: message => calls.push(['write', message.params.data.eventId]),
    waitMs: 25000
  });

  assert.strictEqual(await pump.primeCursor(), null);
  assert.strictEqual(await pump.pollOnce(), 1);
  assert.deepStrictEqual(calls, [
    ['list', 'returning-codex-client', { limit: 100, waitMs: 0 }],
    ['list', 'returning-codex-client', { limit: 20, waitMs: 25000 }],
    ['write', 'evt_51'],
    ['ack', 'returning-codex-client', 'evt_51']
  ]);
});

asyncTest('TaskEventPump does not acknowledge when the transport write fails', async () => {
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

asyncTest('event pumps reject non-200 reads without priming or consuming events', async () => {
  for (const Pump of [TaskEventPump, TaskSubscriptionPump]) {
    for (const status of [202, 204, 302, 304, 401, 429, 503]) {
      const effects = [];
      const pump = new Pump({
        client: {
          async listTaskEvents() {
            return { status, data: {
              clientKnown: false,
              events: [{ eventId: 'evt_2', taskId: 'task-owned', status: 'done' }],
              cursor: 'evt_2', hasMore: false
            } };
          },
          async ackTaskEvent() { effects.push('ack'); return { status: 200 }; }
        },
        clientId: 'non-200-client', after: 'evt_1', taskIds: ['task-owned'],
        taskAdapter: { async get() { effects.push('get'); return {}; } },
        write() { effects.push('write'); }
      });
      await assert.rejects(() => pump.primeCursor(), new RegExp(`HTTP ${status}`));
      await assert.rejects(() => pump.pollOnce(), new RegExp(`HTTP ${status}`));
      assert.strictEqual(pump.historyPrimed, false);
      assert.strictEqual(pump.cursor, 'evt_1');
      assert.deepStrictEqual(effects, []);
    }
  }
});

asyncTest('event acknowledgements require HTTP 200 before advancing the cursor', async () => {
  for (const method of ['primeCursor', 'pollOnce']) {
    for (const status of [202, 302, 429, 503]) {
      const pump = new TaskEventPump({
        client: {
          async listTaskEvents() {
            return { status: 200, data: {
              clientKnown: false,
              events: [{ eventId: 'evt_2', taskId: 'task-owned', status: 'done' }],
              hasMore: false
            } };
          },
          async ackTaskEvent() { return { status, data: { acknowledged: true } }; }
        },
        clientId: 'non-200-ack-client', after: 'evt_1', write() {}
      });
      await assert.rejects(() => pump[method](), new RegExp(`HTTP ${status}`));
      assert.strictEqual(pump.cursor, 'evt_1');
      assert.strictEqual(pump.historyPrimed, false);
    }
  }
});

asyncTest('running event pumps back off for non-200 HTTP responses', async () => {
  for (const Pump of [TaskEventPump, TaskSubscriptionPump]) {
    for (const status of [429, 503, 302, 202, 204, 304]) {
      let requests = 0;
      let firstRequest;
      let watchdog;
      const first = new Promise(resolve => { firstRequest = resolve; });
      const gateway = http.createServer((request, response) => {
        requests++;
        firstRequest();
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'isolated event fixture failure' }));
        if (requests >= 32) pump.stop();
      });
      await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
      const pump = new Pump({
        client: new TraeCNApiClient({
          host: '127.0.0.1', port: gateway.address().port, token: '', timeout: 1000
        }),
        clientId: 'isolated-client', after: 'evt_1', taskIds: ['task-owned'],
        taskAdapter: { async get() { assert.fail('rejected events must not read tasks'); } },
        write() { assert.fail('rejected events must not emit notifications'); }
      });
      pump.historyPrimed = true;
      pump.initialSnapshotsDelivered = true;
      const loop = pump.start();
      try {
        await Promise.race([
          first,
          new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error('Event fixture did not receive a request')), 2000);
          })
        ]);
        clearTimeout(watchdog);
        await new Promise(resolve => setTimeout(resolve, 100));
        pump.stop();
        await loop;
        assert.strictEqual(requests, 1,
          `${Pump.name} retried HTTP ${status} before its default retry delay`);
        assert.strictEqual(pump.cursor, 'evt_1');
      } finally {
        clearTimeout(watchdog);
        pump.stop();
        await loop;
        gateway.closeAllConnections();
        await new Promise(resolve => gateway.close(resolve));
      }
    }
  }
});

asyncTest('stopped event pumps leave an in-flight response undelivered and unacknowledged', async () => {
  for (const Pump of [TaskEventPump, TaskSubscriptionPump]) {
    let releaseRead;
    const calls = [];
    const pump = new Pump({
      client: {
        listTaskEvents() { return new Promise(resolve => { releaseRead = resolve; }); },
        async ackTaskEvent() { calls.push('ack'); }
      },
      clientId: 'stopped-client',
      taskIds: ['task-owned'],
      taskAdapter: { async get() { calls.push('get'); return {}; } },
      write() { calls.push('write'); }
    });
    const pending = pump.pollOnce();
    pump.stop();
    releaseRead({ data: { events: [{ eventId: 'evt-stopped', taskId: 'task-owned' }] } });
    assert.strictEqual(await pending, 0);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(pump.cursor, null);
  }
});

asyncTest('stopped task subscriptions do not write a pending initial task snapshot', async () => {
  let releaseSnapshot;
  const writes = [];
  const pump = new TaskSubscriptionPump({
    client: {},
    taskIds: ['task-owned'],
    taskAdapter: {
      get() { return new Promise(resolve => { releaseSnapshot = resolve; }); }
    },
    write(message) { writes.push(message); }
  });
  const pending = pump.deliverInitialSnapshots();
  pump.stop();
  releaseSnapshot({ taskId: 'task-owned', status: 'working' });
  assert.strictEqual(await pending, 0);
  assert.deepStrictEqual(writes, []);
});

asyncTest('running event pumps abort in-flight gateway requests on stop', async () => {
  for (const Pump of [TaskEventPump, TaskSubscriptionPump]) {
    let requestSignal;
    const pump = new Pump({
      client: {
        listTaskEvents(clientId, options) {
          requestSignal = options.signal;
          return new Promise((resolve, reject) => {
            requestSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
      },
      clientId: 'abort-client',
      taskIds: [],
      taskAdapter: {},
      write() { assert.fail('stopped pump must not write'); }
    });
    const pending = pump.start();
    assert.ok(requestSignal instanceof AbortSignal);
    pump.stop();
    await pending;
    assert.strictEqual(requestSignal.aborted, true);
    assert.strictEqual(pump.running, false);
  }
});

asyncTest('stopping a pump also interrupts its retry delay', async () => {
  const pump = new TaskEventPump({
    client: { async listTaskEvents() { throw new Error('gateway offline'); } },
    clientId: 'retry-client',
    retryMs: 60000
  });
  const pending = pump.start();
  await new Promise(resolve => setImmediate(resolve));
  pump.stop();
  await pending;
  assert.strictEqual(pump.running, false);
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

asyncTest('TaskSubscriptionPump never emits another task result', async () => {
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

asyncTest('TaskSubscriptionPump baselines history before emitting the current task snapshot', async () => {
  const calls = [];
  let listCall = 0;
  let snapshotRead = 0;
  const client = {
    async listTaskEvents(clientId, options) {
      calls.push(['list', clientId, options]);
      listCall += 1;
      if (listCall === 1) {
        return {
          data: {
            events: [
              { eventId: 'evt_30', taskId: 'task-owned', status: 'approval_required' },
              { eventId: 'evt_31', taskId: 'task-foreign', status: 'done' }
            ],
            cursor: 'evt_31',
            hasMore: false
          }
        };
      }
      return {
        data: {
          events: [{ eventId: 'evt_32', taskId: 'task-owned', status: 'done' }],
          cursor: 'evt_32',
          hasMore: false
        }
      };
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
        snapshotRead += 1;
        calls.push(['get', taskId, snapshotRead]);
        return {
          taskId,
          status: snapshotRead === 1 ? 'working' : 'completed',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastUpdatedAt: '2026-08-01T00:01:00.000Z',
          ttlMs: 604800000,
          ...(snapshotRead === 1 ? {} : {
            result: { content: [{ type: 'text', text: 'fresh completion' }], isError: false }
          })
        };
      }
    },
    clientId: 'modern-client:listen-history',
    subscriptionId: 'listen-history',
    taskIds: ['task-owned'],
    write(message) {
      calls.push(['write', message.params.taskId, message.params.status]);
    },
    waitMs: 25000
  });

  assert.strictEqual(await pump.primeCursor(), 'evt_31');
  assert.strictEqual(await pump.deliverInitialSnapshots(), 1);
  assert.strictEqual(await pump.pollOnce(), 1);
  assert.deepStrictEqual(calls, [
    ['list', 'modern-client:listen-history', { limit: 100, waitMs: 0 }],
    ['get', 'task-owned', 1],
    ['write', 'task-owned', 'working'],
    ['list', 'modern-client:listen-history', { limit: 20, waitMs: 25000, after: 'evt_31' }],
    ['get', 'task-owned', 2],
    ['write', 'task-owned', 'completed'],
    ['ack', 'modern-client:listen-history', 'evt_32']
  ]);
});

asyncTest('TaskSubscriptionPump does not duplicate successful initial snapshots after a retry', async () => {
  const writes = [];
  let secondTaskAttempts = 0;
  const pump = new TaskSubscriptionPump({
    client: {},
    taskAdapter: {
      async get(taskId) {
        if (taskId === 'task-b' && ++secondTaskAttempts === 1) {
          throw new Error('temporary task read failure');
        }
        return {
          taskId,
          status: 'working',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastUpdatedAt: '2026-08-01T00:00:00.000Z',
          ttlMs: 604800000
        };
      }
    },
    clientId: 'modern-client:listen-retry',
    subscriptionId: 'listen-retry',
    taskIds: ['task-a', 'task-b'],
    write(message) {
      writes.push(message.params.taskId);
    }
  });

  await assert.rejects(() => pump.deliverInitialSnapshots(), /temporary task read failure/);
  assert.deepStrictEqual(writes, ['task-a']);
  assert.strictEqual(await pump.deliverInitialSnapshots(), 1);
  assert.deepStrictEqual(writes, ['task-a', 'task-b']);
});

asyncTest('stdio opens and cancels a correlated modern task subscription', async () => {
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
  assert.deepStrictEqual(writes[1], subscriptionClosedResult('listen-stdio-1'));
  assert.strictEqual(server.getTaskSubscriptions().size, 0);
  await server.stop();
  assert.strictEqual(writes.length, 2);
});

asyncTest('stdio ignores an id-less subscription notification without starting a pump', async () => {
  const input = new EventEmitter();
  const writes = [];
  let subscribed = false;
  let pumpCreated = false;
  const taskMeta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: { 'io.modelcontextprotocol/tasks': {} }
    }
  };
  const server = startStdioServer({
    input,
    handlers: {
      subscribe() {
        subscribed = true;
        return { taskIds: ['task-owned'] };
      },
      async handle() { return undefined; }
    },
    write(message) { writes.push(message); },
    clientFactory() { return {}; },
    taskSubscriptionPumpFactory() {
      pumpCreated = true;
      return { start() {}, stop() {} };
    }
  });

  input.emit('data', Buffer.from(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'subscriptions/listen',
    params: { notifications: { taskIds: ['task-owned'] }, _meta: taskMeta }
  })}\n`));
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(subscribed, false);
  assert.strictEqual(pumpCreated, false);
  assert.strictEqual(server.getTaskSubscriptions().size, 0);
  assert.deepStrictEqual(writes, []);
  await server.stop();
});

asyncTest('stdio closes a live subscription with the standard graceful result', async () => {
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
          name: 'traecn-mcp',
          title: 'TraeCN MCP',
          version: require('../../package.json').version
        }
      }
    }
  });
});

asyncTest('stdio cancellation during a pending acknowledgement never starts the subscription', async () => {
  const input = new EventEmitter();
  const writes = [];
  let releaseAck;
  let started = 0;
  const server = startStdioServer({
    input,
    handlers: { subscribe() { return { taskIds: ['task-owned'] }; }, async handle() {} },
    write(message) {
      writes.push(message);
      if (message.method === 'notifications/subscriptions/acknowledged') {
        return new Promise(resolve => { releaseAck = resolve; });
      }
    },
    clientFactory() { return {}; },
    taskSubscriptionPumpFactory() { return { start() { started++; }, stop() {} }; }
  });

  await sendInput(input, subscriptionRequest('listen-pending'));
  const cancel = subscriptionRequest(undefined, 'notifications/cancelled');
  cancel.params.requestId = 'listen-pending';
  await sendInput(input, cancel);
  releaseAck();
  await new Promise(resolve => setImmediate(resolve));
  await server.stop();

  assert.strictEqual(started, 0);
  assert.strictEqual(server.getTaskSubscriptions().size, 0);
  assert.deepStrictEqual(writes[1], subscriptionClosedResult('listen-pending'));
  assert.strictEqual(writes.length, 2);
});

asyncTest('stdio shutdown during acknowledgement detaches input and prevents later subscription work', async () => {
  const input = new EventEmitter();
  const writes = [];
  let releaseAck;
  let created = 0;
  const server = startStdioServer({
    input,
    handlers: { subscribe() { return { taskIds: ['task-owned'] }; }, async handle() {} },
    write(message) {
      writes.push(message);
      if (message.method === 'notifications/subscriptions/acknowledged') {
        return new Promise(resolve => { releaseAck = resolve; });
      }
    },
    clientFactory() { return {}; },
    taskSubscriptionPumpFactory() { created++; return { start() {}, stop() {} }; }
  });

  await sendInput(input, subscriptionRequest('listen-shutdown'));
  const stopped = server.stop();
  releaseAck();
  await stopped;
  await sendInput(input, subscriptionRequest('listen-after-shutdown'));

  assert.strictEqual(created, 0);
  assert.strictEqual(input.listenerCount('data'), 0);
  assert.strictEqual(server.getTaskSubscriptions().size, 0);
  assert.deepStrictEqual(writes[1], subscriptionClosedResult('listen-shutdown'));
  assert.strictEqual(writes.length, 2);
});

asyncTest('stdio reserves a subscription identity before awaiting acknowledgement', async () => {
  const input = new EventEmitter();
  const writes = [];
  const acknowledgements = [];
  let started = 0;
  const server = startStdioServer({
    input,
    handlers: { subscribe() { return { taskIds: ['task-owned'] }; }, async handle() {} },
    write(message) {
      writes.push(message);
      if (message.method === 'notifications/subscriptions/acknowledged') {
        return new Promise(resolve => acknowledgements.push(resolve));
      }
    },
    clientFactory() { return {}; },
    taskSubscriptionPumpFactory() { return { start() { started++; }, stop() {} }; }
  });

  await sendInput(input, subscriptionRequest('listen-duplicate'));
  await sendInput(input, subscriptionRequest('listen-duplicate'));
  for (const resolve of acknowledgements) resolve();
  await new Promise(resolve => setImmediate(resolve));
  await server.stop();

  assert.strictEqual(started, 1);
  assert.strictEqual(acknowledgements.length, 1);
  assert.strictEqual(writes[1].error.code, -32600);
});

asyncTest('stdio keeps numeric and string subscription ids distinct', async () => {
  const input = new EventEmitter();
  const stoppedIds = [];
  const writes = [];
  const server = startStdioServer({
    input,
    handlers: { subscribe() { return { taskIds: ['task-owned'] }; }, async handle() {} },
    write(message) { writes.push(message); },
    clientFactory() { return {}; },
    taskSubscriptionPumpFactory(options) {
      return { start() {}, stop() { stoppedIds.push(options.subscriptionId); } };
    }
  });

  await sendInput(input, subscriptionRequest(1));
  await sendInput(input, subscriptionRequest('1'));
  const count = server.getTaskSubscriptions().size;
  const cancel = subscriptionRequest(undefined, 'notifications/cancelled');
  cancel.params.requestId = 1;
  await sendInput(input, cancel);
  const afterCancel = server.getTaskSubscriptions().size;
  await server.stop();

  assert.strictEqual(count, 2);
  assert.strictEqual(afterCancel, 1);
  assert.deepStrictEqual(stoppedIds, [1, '1']);
  assert.ok(!writes.some(message => message.error));
});

asyncTest('an empty task subscription does not poll the gateway', async () => {
  const input = new EventEmitter();
  const writes = [];
  const server = startStdioServer({
    input,
    handlers: { subscribe() { return { taskIds: [] }; }, async handle() {} },
    write(message) { writes.push(message); },
    clientFactory() { assert.fail('an empty subscription must not contact the gateway'); }
  });
  await sendInput(input, subscriptionRequest('listen-empty'));
  await server.stop();
  assert.deepStrictEqual(writes[0], subscriptionAcknowledgedNotification([], 'listen-empty'));
  assert.deepStrictEqual(writes[1], subscriptionClosedResult('listen-empty'));
});

asyncTest('stdio responds to null input and retains requests surrounding malformed JSON', async () => {
  const input = new EventEmitter();
  const writes = [];
  const server = startStdioServer({
    input,
    handlers: { async handle() { return {}; } },
    write(message) { writes.push(message); }
  });
  input.emit('data', Buffer.from('null\n'
    + encodeMessage({ jsonrpc: '2.0', id: 'init', method: 'initialize' })
    + '{malformed}\n'
    + encodeMessage({ jsonrpc: '2.0', id: 'ping', method: 'ping' })));
  await new Promise(resolve => setImmediate(resolve));
  await server.stop();

  assert.strictEqual(writes.length, 4);
  assert.ok(writes.some(message => message.id === null && message.error?.code === -32600));
  assert.ok(writes.some(message => message.id === null && message.error?.code === -32700));
  assert.ok(writes.some(message => message.id === 'init' && message.result));
  assert.ok(writes.some(message => message.id === 'ping' && message.result));
});

asyncTest('stdio permits legacy initialization after rejecting an unsupported modern version', async () => {
  const input = new EventEmitter();
  const writes = [];
  const server = startStdioServer({ input, write(message) { writes.push(message); } });
  const unsupported = subscriptionRequest('unsupported', 'server/discover');
  unsupported.params._meta['io.modelcontextprotocol/protocolVersion'] = '2099-01-01';
  await sendInput(input, unsupported);
  await sendInput(input, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} });
  await server.stop();

  assert.strictEqual(writes[0].error.code, -32022);
  assert.strictEqual(writes[1].result.protocolVersion, '2025-11-25');
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})();
