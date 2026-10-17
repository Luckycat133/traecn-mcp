'use strict';

const assert = require('assert');
const { CompletionSignal } = require('./completion-signal');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('completion-signal.test.js');
const { test, pendingAsyncTests, summary } = runner;

test('CompletionSignal records, broadcasts, notifies and posts one review event in order', async () => {
  const calls = [];
  const signal = new CompletionSignal({
    getTaskEventStore: () => ({
      append(event) { calls.push(['event', event]); }
    }),
    getWebSocketHandler: () => ({
      broadcastEvent(type, data) { calls.push(['websocket', type, data]); }
    }),
    async notifyOpenClaw(chatId, message) { calls.push(['openclaw', chatId, message]); },
    async sendTaskWebhook(url, payload) { calls.push(['webhook', url, payload]); },
    logger: { error() {} }
  });
  const task = {
    status: 'awaiting_review',
    sessionId: 'session-1',
    chatId: 'chat-1',
    notifyUrl: 'https://example.invalid/task',
    followupTasks: [{ task: 'next' }],
    result: { text: 'Review this result', stable: true, elapsedMs: 125 }
  };

  await signal.emit('task-1', task, 'task.review_required', { message: 'ready' });

  assert.deepStrictEqual(calls.map(call => call[0]), ['event', 'websocket', 'openclaw', 'webhook']);
  assert.deepStrictEqual(calls[0][1], {
    type: 'task.review_required',
    taskId: 'task-1',
    status: 'awaiting_review',
    terminal: false,
    attentionRequired: true,
    resultAvailable: true,
    sessionId: 'session-1',
    summary: 'Review this result'
  });
  assert.match(calls[2][2], /Task ID: task-1/);
  assert.strictEqual(calls[3][2].event, 'task.review_required');
  assert.strictEqual(calls[3][2].data.followupCount, 1);
  assert.strictEqual(calls[3][2].data.message, 'ready');
});

test('CompletionSignal contains webhook failures without losing the durable event', async () => {
  const recorded = [];
  const errors = [];
  const signal = new CompletionSignal({
    getTaskEventStore: () => ({ append(event) { recorded.push(event); } }),
    getWebSocketHandler: () => null,
    async notifyOpenClaw() {},
    async sendTaskWebhook() { throw new Error('webhook offline'); },
    logger: { error(...args) { errors.push(args); } }
  });

  await signal.emit('task-2', {
    status: 'error',
    error: 'task failed',
    notifyUrl: 'https://example.invalid/task'
  }, 'task.error');

  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].terminal, true);
  assert.deepStrictEqual(errors, [['[TaskNotify] webhook failed:', 'webhook offline']]);
});

test('CompletionSignal does not deliver notifications when the durable event write fails', async () => {
  const calls = [];
  const errors = [];
  const signal = new CompletionSignal({
    getTaskEventStore: () => ({
      append(event) {
        calls.push(['event-attempt', event]);
        return null;
      }
    }),
    getWebSocketHandler: () => ({
      broadcastEvent(type, data) { calls.push(['websocket', type, data]); }
    }),
    async notifyOpenClaw(chatId, message) { calls.push(['openclaw', chatId, message]); },
    async sendTaskWebhook(url, payload) { calls.push(['webhook', url, payload]); },
    logger: { error(...args) { errors.push(args); } }
  });

  const result = await signal.emit('task-undelivered', {
    status: 'done',
    chatId: 'chat-undelivered',
    notifyUrl: 'https://example.invalid/task',
    result: { text: 'This completion must remain retryable.' }
  }, 'task.completed');

  assert.deepStrictEqual(calls.map(call => call[0]), ['event-attempt']);
  assert.deepStrictEqual(result, { recorded: false, delivered: false });
  assert.deepStrictEqual(errors, [[
    '[TaskNotify] completion event was not durably recorded:',
    'task-undelivered',
    'task.completed'
  ]]);
});

test('CompletionSignal isolates delivery failures across notification channels', async () => {
  const calls = [];
  const signal = new CompletionSignal({
    getTaskEventStore: () => ({ append() { calls.push('event'); return { eventId: 'evt_1' }; } }),
    getWebSocketHandler: () => ({
      broadcastEvent() { calls.push('websocket'); throw new Error('socket offline'); }
    }),
    async notifyOpenClaw() { calls.push('openclaw'); throw new Error('OpenClaw offline'); },
    async sendTaskWebhook() { calls.push('webhook'); },
    logger: { error() {} }
  });

  const result = await signal.emit('task-isolated', {
    status: 'done',
    chatId: 'chat-isolated',
    notifyUrl: 'https://example.invalid/task',
    result: { text: 'The task completed successfully.' }
  }, 'task.completed');

  assert.deepStrictEqual(calls, ['event', 'websocket', 'openclaw', 'webhook']);
  assert.deepStrictEqual(result, { recorded: true, delivered: false });
});

test('CompletionSignal records cancellation as a terminal event', async () => {
  const events = [];
  const signal = new CompletionSignal({
    getTaskEventStore: () => ({ append(event) { events.push(event); return { eventId: 'evt_1' }; } })
  });
  await signal.emit('task-cancelled', { status: 'cancelled' }, 'task.cancelled');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].terminal, true);
  assert.strictEqual(events[0].attentionRequired, false);
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})();
