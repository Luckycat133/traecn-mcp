'use strict';

const assert = require('assert');
const { WebSocketHandler, WS_MAX_PAYLOAD_BYTES, WS_HEARTBEAT_INTERVAL, WS_HEARTBEAT_TIMEOUT } = require('./websocket-handler');
const http = require('http');
const { WebSocket } = require('ws');

let passed = 0;
let failed = 0;
const pendingAsyncTests = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

function asyncTest(name, fn) {
  pendingAsyncTests.push({ name, fn });
}

console.log('\n[websocket-handler.test.js] Running WebSocket handler tests...\n');

test('WebSocket constants: payload cap and heartbeat intervals are sensible', () => {
  assert.ok(WS_MAX_PAYLOAD_BYTES > 0, 'WS_MAX_PAYLOAD_BYTES must be positive');
  assert.ok(WS_MAX_PAYLOAD_BYTES <= 1024 * 1024, 'WS_MAX_PAYLOAD_BYTES must be <= 1 MiB to prevent DoS');
  assert.ok(WS_HEARTBEAT_INTERVAL >= 5000, 'ping interval must be at least 5s');
  assert.ok(WS_HEARTBEAT_TIMEOUT > WS_HEARTBEAT_INTERVAL, 'timeout must exceed ping interval');
});

test('WebSocketHandler initializes with gateway', () => {
  const mockGateway = { token: '', allowedOrigins: '' };
  const handler = new WebSocketHandler(mockGateway);
  assert.strictEqual(handler.gateway, mockGateway);
  assert.ok(handler.taskSubscriptions instanceof Map);
  assert.ok(handler.globalEventListeners instanceof Set);
  assert.ok(handler.clients instanceof Set);
});

test('WebSocketHandler creates subscriptions map', () => {
  const handler = new WebSocketHandler({});
  assert.ok(handler.taskSubscriptions instanceof Map);
  assert.strictEqual(handler.taskSubscriptions.size, 0);
});

test('WebSocketHandler sends JSON messages', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.lastSent = data;
    }
  };

  handler._sendJson(mockWs, { type: 'test', data: 'value' });
  assert.strictEqual(mockWs.lastSent, '{"type":"test","data":"value"}');
});

test('WebSocketHandler calculates progress for queued task', () => {
  const handler = new WebSocketHandler({});
  const task = { status: 'queued' };
  assert.strictEqual(handler._calculateProgress(task), 0);
});

test('WebSocketHandler calculates progress for executing task', () => {
  const handler = new WebSocketHandler({});
  const task = { status: 'executing' };
  assert.strictEqual(handler._calculateProgress(task), 50);
});

test('WebSocketHandler calculates progress for done task', () => {
  const handler = new WebSocketHandler({});
  const task = { status: 'done' };
  assert.strictEqual(handler._calculateProgress(task), 100);
});

test('WebSocketHandler calculates progress for error task', () => {
  const handler = new WebSocketHandler({});
  const task = { status: 'error' };
  assert.strictEqual(handler._calculateProgress(task), -1);
});

test('WebSocketHandler calculates progress for cancelled task', () => {
  const handler = new WebSocketHandler({});
  const task = { status: 'cancelled' };
  assert.strictEqual(handler._calculateProgress(task), -1);
});

test('WebSocketHandler calculates progress for unknown status', () => {
  const handler = new WebSocketHandler({});
  const task = { status: 'unknown' };
  assert.strictEqual(handler._calculateProgress(task), null);
});

test('WebSocketHandler secureCompare returns true for matching strings', () => {
  const handler = new WebSocketHandler({});
  assert.strictEqual(handler._secureCompare('token123', 'token123'), true);
});

test('WebSocketHandler secureCompare returns false for different strings', () => {
  const handler = new WebSocketHandler({});
  assert.strictEqual(handler._secureCompare('token123', 'token456'), false);
});

test('WebSocketHandler secureCompare returns false for non-string inputs', () => {
  const handler = new WebSocketHandler({});
  assert.strictEqual(handler._secureCompare(null, 'token'), false);
  assert.strictEqual(handler._secureCompare('token', null), false);
  assert.strictEqual(handler._secureCompare(123, 'token'), false);
});

test('WebSocketHandler broadcasts AI response to task subscribers', () => {
  const handler = new WebSocketHandler({});
  const mockWs1 = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };
  const mockWs2 = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  handler.taskSubscriptions.set('task1', new Set([
    { ws: mockWs1, type: 'task' },
    { ws: mockWs2, type: 'task' }
  ]));

  handler.broadcastAIResponse('task1', 'Hello ', false);
  assert.strictEqual(mockWs1.messages.length, 1);
  assert.strictEqual(mockWs1.messages[0].type, 'aiResponse');
  assert.strictEqual(mockWs1.messages[0].chunk, 'Hello ');
  assert.strictEqual(mockWs1.messages[0].done, false);

  handler.broadcastAIResponse('task1', 'World!', true);
  assert.strictEqual(mockWs1.messages.length, 2);
  assert.strictEqual(mockWs1.messages[1].chunk, 'World!');
  assert.strictEqual(mockWs1.messages[1].done, true);
});

test('WebSocketHandler broadcasts approval required', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  handler.globalEventListeners.add({ ws: mockWs, type: 'events' });

  handler.broadcastApprovalRequired('task1', 'Do you approve?', 'confirm');

  assert.strictEqual(mockWs.messages.length, 1);
  assert.strictEqual(mockWs.messages[0].type, 'approvalRequired');
  assert.strictEqual(mockWs.messages[0].taskId, 'task1');
  assert.strictEqual(mockWs.messages[0].question, 'Do you approve?');
  assert.strictEqual(mockWs.messages[0].dialogType, 'confirm');
});

test('WebSocketHandler broadcasts task status change', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  handler.taskSubscriptions.set('task1', new Set([
    { ws: mockWs, type: 'task', taskId: 'task1' }
  ]));
  handler.globalEventListeners.add({ ws: mockWs, type: 'events' });

  const task = {
    status: 'done',
    result: { text: 'Completed', stable: true }
  };

  handler.notifyTaskStatusChange('task1', task);

  assert.strictEqual(mockWs.messages.length, 2);
  assert.strictEqual(mockWs.messages[0].type, 'taskUpdate');
  assert.strictEqual(mockWs.messages[1].type, 'taskStatusChanged');
});

test('WebSocketHandler broadcasts event to global listeners', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  handler.globalEventListeners.add({ ws: mockWs, type: 'events' });

  handler.broadcastEvent('taskCreated', { taskId: 'task1' });

  assert.strictEqual(mockWs.messages.length, 1);
  assert.strictEqual(mockWs.messages[0].type, 'event');
  assert.strictEqual(mockWs.messages[0].eventType, 'taskCreated');
  assert.deepStrictEqual(mockWs.messages[0].data, { taskId: 'task1' });
});

test('WebSocketHandler cleanup removes client from all subscriptions', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function() {}
  };

  const clientInfo1 = { ws: mockWs, type: 'task', taskId: 'task1' };
  const clientInfo2 = { ws: mockWs, type: 'events' };

  handler.taskSubscriptions.set('task1', new Set([clientInfo1]));
  handler.globalEventListeners.add(clientInfo2);
  handler.clients.add(clientInfo1);
  handler.clients.add(clientInfo2);

  handler._cleanupClient(clientInfo1);

  assert.strictEqual(handler.clients.has(clientInfo1), false);
  assert.strictEqual(handler.globalEventListeners.has(clientInfo1), false);
  assert.strictEqual(handler.taskSubscriptions.has('task1'), false);
});

test('WebSocketHandler close terminates all connections', () => {
  const handler = new WebSocketHandler({});
  const mockWs1 = {
    readyState: 1,
    close: function() { this.closed = true; }
  };
  const mockWs2 = {
    readyState: 1,
    close: function() { this.closed = true; }
  };

  handler.clients.add({ ws: mockWs1, type: 'task' });
  handler.clients.add({ ws: mockWs2, type: 'events' });
  handler.taskSubscriptions.set('task1', new Set([{ ws: mockWs1 }]));
  handler.globalEventListeners.add({ ws: mockWs2 });

  handler.close();

  assert.strictEqual(mockWs1.closed, true);
  assert.strictEqual(mockWs2.closed, true);
  assert.strictEqual(handler.clients.size, 0);
  assert.strictEqual(handler.taskSubscriptions.size, 0);
  assert.strictEqual(handler.globalEventListeners.size, 0);
});

test('WebSocketHandler handles _checkOrigin with no allowed origins', () => {
  const handler = new WebSocketHandler({ allowedOrigins: '' });
  const request = { headers: {} };

  assert.strictEqual(handler._checkOrigin(request), true);
});

test('WebSocketHandler handles _checkOrigin with matching origin', () => {
  const handler = new WebSocketHandler({ allowedOrigins: 'https://example.com' });
  const request = { headers: { origin: 'https://example.com' } };

  assert.strictEqual(handler._checkOrigin(request), true);
});

test('WebSocketHandler handles _checkOrigin with non-matching origin', () => {
  const handler = new WebSocketHandler({ allowedOrigins: 'https://example.com' });
  const request = { headers: { origin: 'https://other.com' } };

  assert.strictEqual(handler._checkOrigin(request), false);
});

test('WebSocketHandler handles _checkOrigin with wildcard', () => {
  const handler = new WebSocketHandler({ allowedOrigins: '*' });
  const request = { headers: { origin: 'https://any.com' } };

  assert.strictEqual(handler._checkOrigin(request), true);
});

test('WebSocketHandler handles _handleUpgradeAuth without token', () => {
  const handler = new WebSocketHandler({ token: '' });
  const request = { headers: {} };
  const context = { authenticated: false };

  assert.strictEqual(handler._handleUpgradeAuth(request, context), true);
  assert.strictEqual(context.authenticated, true);
});

test('WebSocketHandler handles _handleUpgradeAuth with valid bearer token', () => {
  const crypto = require('crypto');
  const token = 'secret-token';
  const handler = new WebSocketHandler({
    token,
    authHeader: 'Authorization'
  });
  const request = { headers: { authorization: 'Bearer ' + token } };
  const context = { authenticated: false };

  assert.strictEqual(handler._handleUpgradeAuth(request, context), true);
  assert.strictEqual(context.authenticated, true);
});

test('WebSocketHandler handles _handleUpgradeAuth with invalid bearer token', () => {
  const crypto = require('crypto');
  const token = 'secret-token';
  const handler = new WebSocketHandler({
    token,
    authHeader: 'Authorization'
  });
  const request = { headers: { authorization: 'Bearer wrong-token' } };
  const context = { authenticated: false };

  assert.strictEqual(handler._handleUpgradeAuth(request, context), false);
  assert.strictEqual(context.authenticated, false);
});

test('WebSocketHandler handles _handleUpgradeAuth with X-TraeCN-Token header', () => {
  const crypto = require('crypto');
  const token = 'secret-token';
  const handler = new WebSocketHandler({
    token,
    authHeader: 'Authorization'
  });
  const request = { headers: { 'x-traecn-token': token } };
  const context = { authenticated: false };

  assert.strictEqual(handler._handleUpgradeAuth(request, context), true);
  assert.strictEqual(context.authenticated, true);
});

test('WebSocketHandler sends task update for queued task', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  handler.taskSubscriptions.set('task1', new Set([
    { ws: mockWs, type: 'task', taskId: 'task1' }
  ]));

  const task = {
    status: 'queued',
    createdAt: Date.now() - 5000,
    deadline: Date.now() + 300000
  };

  handler._sendTaskUpdate('task1', task);

  assert.strictEqual(mockWs.messages.length, 1);
  assert.strictEqual(mockWs.messages[0].type, 'taskUpdate');
  assert.strictEqual(mockWs.messages[0].taskId, 'task1');
  assert.strictEqual(mockWs.messages[0].status, 'queued');
  assert.strictEqual(mockWs.messages[0].progress, 0);
  assert.ok(mockWs.messages[0].queueElapsed >= 5000);
  assert.ok(mockWs.messages[0].remaining > 0);
});

test('WebSocketHandler sends task update for done task with result', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  handler.taskSubscriptions.set('task1', new Set([
    { ws: mockWs, type: 'task', taskId: 'task1' }
  ]));

  const task = {
    status: 'done',
    result: {
      text: 'Task completed successfully',
      stable: true,
      elapsedMs: 5000,
      timedOut: false,
      needsApproval: false
    }
  };

  handler._sendTaskUpdate('task1', task);

  assert.strictEqual(mockWs.messages.length, 1);
  assert.strictEqual(mockWs.messages[0].type, 'taskUpdate');
  assert.strictEqual(mockWs.messages[0].status, 'done');
  assert.strictEqual(mockWs.messages[0].progress, 100);
  assert.strictEqual(mockWs.messages[0].result.text, 'Task completed successfully');
  assert.strictEqual(mockWs.messages[0].result.stable, true);
});

test('WebSocketHandler sends task update for error task', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  handler.taskSubscriptions.set('task1', new Set([
    { ws: mockWs, type: 'task', taskId: 'task1' }
  ]));

  const task = {
    status: 'error',
    error: 'Something went wrong'
  };

  handler._sendTaskUpdate('task1', task);

  assert.strictEqual(mockWs.messages.length, 1);
  assert.strictEqual(mockWs.messages[0].type, 'taskUpdate');
  assert.strictEqual(mockWs.messages[0].status, 'error');
  assert.strictEqual(mockWs.messages[0].progress, -1);
  assert.strictEqual(mockWs.messages[0].error, 'Something went wrong');
});

test('WebSocketHandler does not send if no subscribers', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 1,
    send: function() { this.called = true; }
  };

  handler.taskSubscriptions.set('task1', new Set());

  const task = { status: 'done' };
  handler._sendTaskUpdate('task1', task);

  assert.strictEqual(mockWs.called, undefined);
});

test('WebSocketHandler does not send to closed connections', () => {
  const handler = new WebSocketHandler({});
  const mockWs = {
    readyState: 3,
    send: function() { this.called = true; }
  };

  handler.taskSubscriptions.set('task1', new Set([
    { ws: mockWs, type: 'task', taskId: 'task1' }
  ]));

  const task = { status: 'queued' };
  handler._sendTaskUpdate('task1', task);

  assert.strictEqual(mockWs.called, undefined);
});

test('WebSocketHandler subscribe and unsubscribe to task from events endpoint', () => {
  const handler = new WebSocketHandler({ taskQueue: new Map() });
  const mockWs = {
    readyState: 1,
    send: function(data) {
      this.messages = this.messages || [];
      this.messages.push(JSON.parse(data));
    }
  };

  const clientInfo = { ws: mockWs, type: 'events', subscribed: true };
  handler.clients.add(clientInfo);
  handler.globalEventListeners.add(clientInfo);

  handler._subscribeToTask(clientInfo, 'task1');

  assert.ok(handler.taskSubscriptions.has('task1'));
  assert.ok(handler.taskSubscriptions.get('task1').has(clientInfo));

  assert.strictEqual(mockWs.messages.length, 1);
  assert.strictEqual(mockWs.messages[0].type, 'subscribed');
  assert.strictEqual(mockWs.messages[0].taskId, 'task1');

  handler._unsubscribeFromTask(clientInfo, 'task1');

  assert.strictEqual(handler.taskSubscriptions.has('task1'), false);

  assert.strictEqual(mockWs.messages.length, 2);
  assert.strictEqual(mockWs.messages[1].type, 'unsubscribed');
  assert.strictEqual(mockWs.messages[1].taskId, 'task1');
});

asyncTest('WebSocketHandler accepts direct task websocket subscriptions on /ws/tasks/:id', async () => {
  const gateway = {
    token: '',
    allowedOrigins: '',
    taskQueue: new Map([
      ['task-live-1', { status: 'queued', createdAt: Date.now(), deadline: Date.now() + 5000 }]
    ])
  };
  const handler = new WebSocketHandler(gateway);
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  handler.initialize(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const messages = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tasks/task-live-1`);
      const received = [];
      const timer = setTimeout(() => {
        ws.close();
        resolve(received);
      }, 1000);

      ws.on('message', data => {
        received.push(JSON.parse(data.toString()));
        if (received.length >= 2) {
          clearTimeout(timer);
          ws.close();
          resolve(received);
        }
      });
      ws.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.strictEqual(messages[0].type, 'subscribed');
    assert.strictEqual(messages[1].type, 'taskUpdate');
    assert.strictEqual(messages[1].taskId, 'task-live-1');
  } finally {
    handler.close();
    await new Promise(resolve => server.close(resolve));
  }
});

(async () => {
  for (const { name, fn } of pendingAsyncTests) {
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

  console.log(`\n[websocket-handler.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
