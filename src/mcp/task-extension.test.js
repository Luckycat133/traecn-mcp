'use strict';

const assert = require('assert');
const {
  TASKS_EXTENSION_ID,
  McpTaskAdapter,
  assertTaskExtension,
  clientSupportsTaskExtension,
  taskIdempotencyKey,
  taskSubscriptionNotification,
  detailedTaskFromGateway
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
    error => error.code === -32021
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

test('modern task detail and notifications preserve real workflow metadata', () => {
  for (const status of ['executing', 'done']) {
    const snapshot = {
      taskId: 'task-workflow-detail', status,
      result: { text: 'Reviewed result', stable: true },
      metadata: {
        source: 'owned-workflow', custom: { retained: true },
        workflowParentTaskId: 'task-real-parent', nextTaskId: 'task-real-child'
      }
    };
    const detail = detailedTaskFromGateway(snapshot);
    assert.deepStrictEqual(detail.metadata, snapshot.metadata);
    assert.strictEqual(detail.nextTaskId, undefined, 'protocol metadata stays in its standard field');
    assert.strictEqual(detail.workflowParentTaskId, undefined);
    const notification = taskSubscriptionNotification(detail, 'listen-workflow');
    assert.deepStrictEqual(notification.params.metadata, snapshot.metadata);
    assert.strictEqual(notification.params._meta['io.modelcontextprotocol/subscriptionId'], 'listen-workflow');
    assert.deepStrictEqual(snapshot.metadata.custom, { retained: true });
  }
  const standalone = detailedTaskFromGateway({ taskId: 'task-standalone-detail', status: 'executing' });
  assert.strictEqual(standalone.metadata, undefined, 'missing links must not become fabricated identifiers');
});

test('modern task detail projects actual top-level workflow links without losing metadata', () => {
  const snapshot = {
    taskId: 'task-top-level-links', status: 'done', result: { text: 'Reviewed result' },
    metadata: { source: 'owned-workflow' },
    workflowParentTaskId: 'task-real-parent', nextTaskId: 'task-real-child'
  };
  assert.deepStrictEqual(detailedTaskFromGateway(snapshot).metadata, {
    source: 'owned-workflow', workflowParentTaskId: 'task-real-parent', nextTaskId: 'task-real-child'
  });
  assert.deepStrictEqual(snapshot.metadata, { source: 'owned-workflow' });
});

test('task execution errors preserve gateway codes and distinguish model queue timeouts', () => {
  const coded = detailedTaskFromGateway({
    taskId: 'task-error', status: 'error', error: 'Model failed', errorCode: 'MODEL_UNAVAILABLE'
  });
  assert.strictEqual(coded.result.structuredContent.code, 'MODEL_UNAVAILABLE');
  const queued = detailedTaskFromGateway({
    taskId: 'task-queue', status: 'queue_timeout', error: 'Task exceeded queue wait timeout'
  });
  assert.strictEqual(queued.status, 'completed');
  assert.strictEqual(queued.result.isError, true);
  assert.strictEqual(queued.result.structuredContent.code, 'queue_timeout');
  assert.strictEqual(queued.result.structuredContent.retryable, true);
  assert.match(queued.result.structuredContent.nextAction, /model/);
  assert.deepStrictEqual(JSON.parse(queued.result.content[0].text), queued.result.structuredContent);
});

test('pending cancellation does not resurface a previous review or approval input', () => {
  for (const previous of [
    { status: 'awaiting_review', result: { text: 'Review this result' } },
    { status: 'approval_required', result: { command: 'git push', commandRisk: 'high' } },
    { status: 'approval_required', result: { question: 'Which option?', options: ['保留', '取消'] } }
  ]) {
    const snapshot = { taskId: 'task-cancel-input', ...previous };
    assert.strictEqual(detailedTaskFromGateway(snapshot).status, 'input_required');
    const pending = detailedTaskFromGateway({ ...snapshot, cancelPersistencePending: true });
    assert.strictEqual(pending.status, 'working');
    assert.strictEqual(pending.inputRequests, undefined);
    assert.strictEqual(pending.result, undefined);
  }
});

test('unconfirmed task states never surface a terminal result or checkpoint input', () => {
  for (const status of [
    'done', 'error', 'queue_timeout', 'review_rejected', 'awaiting_review', 'approval_required'
  ]) {
    const task = detailedTaskFromGateway({
      taskId: 'task-state-pending', status, statePersistencePending: true,
      result: { text: 'Unconfirmed result', command: 'git push', commandRisk: 'high' },
      error: 'Unconfirmed error'
    });
    assert.strictEqual(task.status, 'working');
    assert.strictEqual(task.result, undefined);
    assert.strictEqual(task.inputRequests, undefined);
  }
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
  assert.deepStrictEqual(JSON.parse(task.result.content[0].text), task.result.structuredContent);
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

asyncTest('McpTaskAdapter validates task identities before contacting the gateway', async () => {
  let called = false;
  const adapter = new McpTaskAdapter({
    client: { async getTaskStatus() { called = true; return { status: 200, data: {} }; } }
  });
  for (const taskId of [null, 1, {}, [], '', ' ']) {
    await assert.rejects(() => adapter.get(taskId), error => error.code === -32602);
  }
  assert.strictEqual(called, false);
});

asyncTest('McpTaskAdapter rejects malformed snapshots and mismatched task identities', async () => {
  for (const snapshot of [[], { taskId: 'task-foreign', status: 'done' }]) {
    const adapter = new McpTaskAdapter({
      client: { async getTaskStatus() { return { status: 200, data: snapshot }; } }
    });
    await assert.rejects(() => adapter.get('task-owned'), error => error.code === -32603);
  }
});

asyncTest('McpTaskAdapter reports gateway transport failures as protocol internal errors', async () => {
  const client = {
    async getTaskStatus(taskId) {
      return { status: 200, data: {
        taskId, status: 'approval_required', interactionRequestId: 'command-1',
        result: { command: 'git push', commandRisk: 'high' }
      } };
    },
    async cancelTask() { throw new Error('gateway connection failed'); },
    async resolveInteraction() { throw new Error('gateway connection failed'); }
  };
  const adapter = new McpTaskAdapter({ client });
  await assert.rejects(() => adapter.cancel('task-owned'), error => error.code === -32603);
  await assert.rejects(() => adapter.update('task-owned', {
    'traecn.commandApproval.command-1': { action: 'decline' }
  }), error => error.code === -32603);
  client.getTaskStatus = async () => { throw new Error('gateway connection failed'); };
  await assert.rejects(() => adapter.get('task-owned'), error => error.code === -32603);
});

asyncTest('task input validates the advertised schema before invoking an interaction', async () => {
  const cases = [
    {
      status: 'approval_required',
      result: { command: 'git push', commandRisk: 'high' },
      responses: [
        { content: { decision: 'approve', acknowledgeRisk: true, reason: 'authorized' } },
        { action: 'invalid' },
        { action: 'accept', content: { decision: 'approve', acknowledgeRisk: true, reason: 123 } }
      ]
    },
    {
      status: 'approval_required',
      result: { question: 'Which option?', options: ['保留', '取消'] },
      responses: [
        { action: 'accept', content: { answer: 123 } },
        { action: 'accept', content: { answer: 'an unlisted option' } }
      ]
    },
    {
      status: 'awaiting_review',
      result: { text: 'Review this result' },
      responses: [
        { action: 'accept', content: { decision: 'continue', notes: { invalid: true } } },
        { action: 'accept', content: { decision: 'continue', notes: 'x'.repeat(4001) } }
      ]
    }
  ];
  let mutations = 0;
  for (const entry of cases) {
    const adapter = new McpTaskAdapter({
      client: {
        async getTaskStatus(taskId) {
          return { status: 200, data: { taskId, ...entry, interactionRequestId: 'input-schema' } };
        },
        async resolveInteraction() { mutations++; return { status: 200 }; },
        async resolveTaskReview() { mutations++; return { status: 200 }; }
      }
    });
    const task = await adapter.get('task-input');
    const key = Object.keys(task.inputRequests)[0];
    for (const response of entry.responses) {
      await assert.rejects(() => adapter.update('task-input', { [key]: response }),
        error => error.code === -32602);
    }
  }
  assert.strictEqual(mutations, 0);
});

asyncTest('McpTaskAdapter propagates non-terminal gateway cancellation failures', async () => {
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus(taskId) {
        return {
          status: 200,
          data: { taskId, status: 'queued', createdAt: 1785542400000 }
        };
      },
      async cancelTask() {
        return { status: 401, data: { error: 'Unauthorized' } };
      }
    }
  });

  await assert.rejects(
    () => adapter.cancel('task-cancel-auth'),
    error => error.code === -32603 && /Unauthorized/.test(error.message)
  );
});

asyncTest('McpTaskAdapter treats a terminal cancellation race as an idempotent no-op', async () => {
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus(taskId) {
        return {
          status: 200,
          data: { taskId, status: 'queued', createdAt: 1785542400000 }
        };
      },
      async cancelTask() {
        return {
          status: 400,
          data: { error: 'Task is not in a cancellable state', status: 'done' }
        };
      }
    }
  });

  assert.deepStrictEqual(await adapter.cancel('task-cancel-race'), {});
});

asyncTest('McpTaskAdapter rejects a terminal cancellation race while its snapshot persistence is pending', async () => {
  for (const field of ['cancelPersistencePending', 'statePersistencePending']) {
    for (const terminalStatus of ['done', 'error']) {
      let cancellations = 0;
      const adapter = new McpTaskAdapter({ client: {
        async getTaskStatus(taskId) {
          return { status: 200, data: { taskId, status: 'executing', [field]: true } };
        },
        async cancelTask() {
          cancellations++;
          return {
            status: 400,
            data: { error: 'Task is not in a cancellable state', status: terminalStatus }
          };
        }
      } });
      await assert.rejects(() => adapter.cancel('task-pending-cancel-race'),
        error => error.code === -32603 && /Task is not in a cancellable state/.test(error.message));
      assert.strictEqual(cancellations, 1);
    }
  }
});

asyncTest('McpTaskAdapter retries cancellation until pending persistence has been confirmed', async () => {
  let storageRestored = false;
  let cancellations = 0;
  const snapshot = {
    taskId: 'task-cancel-pending', status: 'cancelled', createdAt: 1785542400000,
    cancelPersistencePending: true
  };
  const adapter = new McpTaskAdapter({
    client: {
      async getTaskStatus() { return { status: 200, data: { ...snapshot } }; },
      async cancelTask(taskId) {
        assert.strictEqual(taskId, snapshot.taskId);
        cancellations++;
        if (!storageRestored) {
          return { status: 503, data: {
            error: 'TASK_STORE_UNAVAILABLE', status: 'cancelled', cancelPersistencePending: true
          } };
        }
        delete snapshot.cancelPersistencePending;
        snapshot.status = 'cancelled';
        return { status: 200, data: { taskId, status: 'cancelled' } };
      }
    }
  });

  const pending = await adapter.get(snapshot.taskId);
  assert.strictEqual(pending.status, 'working');
  await assert.rejects(() => adapter.cancel(snapshot.taskId),
    error => error.code === -32603 && /TASK_STORE_UNAVAILABLE/.test(error.message));
  assert.strictEqual(cancellations, 1);
  snapshot.status = 'executing';
  assert.strictEqual((await adapter.get(snapshot.taskId)).status, 'working');
  storageRestored = true;
  assert.deepStrictEqual(await adapter.cancel(snapshot.taskId), {});
  assert.strictEqual(cancellations, 2);
  assert.strictEqual((await adapter.get(snapshot.taskId)).status, 'cancelled');
  assert.deepStrictEqual(await adapter.cancel(snapshot.taskId), {});
  assert.strictEqual(cancellations, 2, 'confirmed cancellation remains an idempotent no-op');
});

asyncTest('pending task persistence ignores cached responses to the superseded interaction', async () => {
  const snapshot = {
    taskId: 'task-cancel-input', status: 'approval_required', interactionRequestId: 'previous-command',
    result: { command: 'git push', commandRisk: 'high' }
  };
  let interactions = 0;
  const adapter = new McpTaskAdapter({ client: {
    async getTaskStatus() { return { status: 200, data: { ...snapshot } }; },
    async resolveInteraction() { interactions++; return { status: 200, data: { success: true } }; }
  } });
  const requestKey = Object.keys((await adapter.get(snapshot.taskId)).inputRequests)[0];
  for (const field of ['cancelPersistencePending', 'statePersistencePending']) {
    snapshot[field] = true;
    assert.deepStrictEqual(await adapter.update(snapshot.taskId, {
      [requestKey]: { action: 'accept', content: {
        decision: 'approve', acknowledgeRisk: true, reason: 'Previously authorized action'
      } }
    }), {});
    delete snapshot[field];
  }
  assert.strictEqual(interactions, 0);
});

asyncTest('McpTaskAdapter forwards cancellation for an unconfirmed terminal candidate', async () => {
  const snapshot = { taskId: 'task-terminal-pending', status: 'done', statePersistencePending: true };
  let cancellations = 0;
  const adapter = new McpTaskAdapter({ client: {
    async getTaskStatus() { return { status: 200, data: { ...snapshot } }; },
    async cancelTask(taskId) {
      assert.strictEqual(taskId, snapshot.taskId);
      cancellations++;
      return { status: 503, data: { error: 'TASK_STORE_UNAVAILABLE' } };
    }
  } });
  await assert.rejects(() => adapter.cancel(snapshot.taskId), error => error.code === -32603);
  assert.strictEqual(cancellations, 1);
  delete snapshot.statePersistencePending;
  assert.deepStrictEqual(await adapter.cancel(snapshot.taskId), {});
  assert.strictEqual(cancellations, 1, 'confirmed terminal state remains a no-op');
});

asyncTest('McpTaskAdapter does not acknowledge failed cancellation responses carrying terminal status', async () => {
  for (const response of [
    { status: 503, data: { error: 'TASK_STORE_UNAVAILABLE', status: 'cancelled' } },
    { status: 400, data: { error: 'TASK_STORE_UNAVAILABLE', status: 'cancelled', cancelPersistencePending: true } },
    { status: 400, data: { error: 'TASK_STORE_UNAVAILABLE', status: 'done', statePersistencePending: true } },
    { status: 200, data: { success: false, error: 'TASK_STORE_UNAVAILABLE', status: 'cancelled' } }
  ]) {
    const adapter = new McpTaskAdapter({
      client: {
        async getTaskStatus(taskId) { return { status: 200, data: { taskId, status: 'executing' } }; },
        async cancelTask() { return response; }
      }
    });
    await assert.rejects(() => adapter.cancel('task-cancel-failed'),
      error => error.code === -32603 && /TASK_STORE_UNAVAILABLE/.test(error.message));
  }
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
