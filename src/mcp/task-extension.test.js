'use strict';

const assert = require('assert');
const {
  TASKS_EXTENSION_ID,
  McpTaskAdapter,
  assertTaskExtension,
  clientSupportsTaskExtension,
  taskIdempotencyKey,
  taskSubscriptionNotification
} = require('./task-extension');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('task-extension.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

function modernRequest(method, params = {}, supportsTasks = true) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': supportsTasks
          ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
          : {}
      }
    }
  };
}

test('task extension is negotiated per modern request', () => {
  assert.strictEqual(clientSupportsTaskExtension(modernRequest('tools/call')), true);
  assert.strictEqual(clientSupportsTaskExtension(modernRequest('tools/call', {}, false)), false);
  assert.throws(
    () => assertTaskExtension(modernRequest('tasks/get', { taskId: 'task-1' }, false)),
    error => error.code === -32003
      && Boolean(error.data.requiredCapabilities.extensions[TASKS_EXTENSION_ID])
  );
});

test('modern task retries derive a stable idempotency key from request identity and arguments', () => {
  const request = modernRequest('tools/call', {
    name: 'traecn_send_message',
    arguments: { message: 'same durable work' }
  });
  request.id = 'call-42';
  const first = taskIdempotencyKey(request);
  const retry = taskIdempotencyKey(JSON.parse(JSON.stringify(request)));
  const different = taskIdempotencyKey({
    ...request,
    params: { ...request.params, arguments: { message: 'different work' } }
  });
  assert.match(first, /^mcp-task-[a-f0-9]{64}$/);
  assert.strictEqual(retry, first);
  assert.notStrictEqual(different, first);
});

asyncTest('McpTaskAdapter reuses the durable gateway task identity', async () => {
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus(taskId) {
        return {
          status: 200,
          data: {
            taskId,
            status: 'queued',
            createdAt: 1785542400000,
            message: '队列等待中'
          }
        };
      }
    }
  });

  const task = await adapter.create({ taskId: 'task-durable-1', status: 'accepted' });
  assert.deepStrictEqual(task, {
    resultType: 'task',
    taskId: 'task-durable-1',
    status: 'working',
    statusMessage: '队列等待中',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastUpdatedAt: '2026-08-01T00:00:00.000Z',
    ttlMs: 604800000,
    pollIntervalMs: 5000
  });
});

asyncTest('McpTaskAdapter returns the final tool result inline', async () => {
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus(taskId) {
        return {
          status: 200,
          data: {
            taskId,
            status: 'done',
            createdAt: 1785542400000,
            completedAt: '2026-08-01T00:01:00.000Z',
            result: { text: 'Final TraeCN answer', stable: true }
          }
        };
      }
    }
  });

  const task = await adapter.get('task-durable-2');
  assert.strictEqual(task.status, 'completed');
  assert.strictEqual(task.result.resultType, undefined);
  assert.strictEqual(task.result.content[0].text, 'Final TraeCN answer');
  assert.deepStrictEqual(task.result.structuredContent, {
    text: 'Final TraeCN answer',
    stable: true
  });
  assert.strictEqual(task.result.isError, false);
});

asyncTest('McpTaskAdapter keeps gateway execution errors as completed tool errors', async () => {
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus(taskId) {
        return {
          status: 200,
          data: {
            taskId,
            status: 'error',
            createdAt: 1785542400000,
            error: 'TraeCN model failed'
          }
        };
      }
    }
  });

  const task = await adapter.get('task-error-1');
  assert.strictEqual(task.status, 'completed');
  assert.strictEqual(task.result.isError, true);
  assert.match(task.result.content[0].text, /TraeCN model failed/);
});

asyncTest('McpTaskAdapter exposes an approval pause as task input_required', async () => {
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus(taskId) {
        return {
          status: 200,
          data: {
            taskId,
            status: 'approval_required',
            createdAt: 1785542400000,
            interactionRequestId: 'interaction-command-1',
            result: {
              dialogType: 'command_execution',
              question: 'Run this command?',
              command: 'git push origin main',
              commandRisk: 'high',
              riskReasons: ['git_write_or_remote']
            }
          }
        };
      }
    }
  });

  const task = await adapter.get('task-input-1');
  assert.strictEqual(task.status, 'input_required');
  const entries = Object.entries(task.inputRequests);
  assert.strictEqual(entries.length, 1);
  const [requestKey, request] = entries[0];
  assert.match(requestKey, /interaction-command-1/);
  assert.strictEqual(request.method, 'elicitation/create');
  assert.match(request.params.message, /git push origin main/);
  assert.deepStrictEqual(request.params.requestedSchema.properties.decision.enum, ['approve', 'deny']);
});

asyncTest('McpTaskAdapter applies task input to the exact current command approval', async () => {
  const calls = [];
  const snapshot = {
    taskId: 'task-input-2',
    status: 'approval_required',
    createdAt: 1785542400000,
    interactionRequestId: 'interaction-command-2',
    result: {
      dialogType: 'command_execution',
      question: 'Run this command?',
      command: 'npm publish',
      commandRisk: 'high',
      riskReasons: ['package_publish']
    }
  };
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus() {
        return { status: 200, data: snapshot };
      },
      async resolveInteraction(input) {
        calls.push(input);
        return { status: 200, data: { success: true } };
      }
    }
  });
  const task = await adapter.get(snapshot.taskId);
  const requestKey = Object.keys(task.inputRequests)[0];

  assert.deepStrictEqual(await adapter.update(snapshot.taskId, {
    [requestKey]: {
      action: 'accept',
      content: {
        decision: 'approve',
        acknowledgeRisk: true,
        reason: 'Release was explicitly requested'
      }
    }
  }), {});
  assert.deepStrictEqual(calls, [{
    action: 'approve',
    expectedCommand: 'npm publish',
    acknowledgeRisk: true,
    reason: 'Release was explicitly requested'
  }]);
});

asyncTest('McpTaskAdapter rejects unknown task ids as invalid params', async () => {
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus() {
        return { status: 404, data: { error: 'Task not found' } };
      }
    }
  });
  await assert.rejects(() => adapter.get('missing'), error => error.code === -32602);
});

test('task subscription notifications carry the complete task and subscription id', () => {
  const notification = taskSubscriptionNotification({
    taskId: 'task-only-this-one',
    status: 'completed',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastUpdatedAt: '2026-08-01T00:01:00.000Z',
    ttlMs: 604800000,
    result: { content: [{ type: 'text', text: 'done' }], isError: false }
  }, 'listen-7');
  assert.strictEqual(notification.method, 'notifications/tasks');
  assert.strictEqual(notification.params.taskId, 'task-only-this-one');
  assert.strictEqual(
    notification.params._meta['io.modelcontextprotocol/subscriptionId'],
    'listen-7'
  );
});

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
});
