'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskEventStore } = require('./task-event-store');
const { createRunner } = require('./test-runner');

const r = createRunner('task-event-store.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = r;

console.log('\n[task-event-store.test.js] Running tests...\n');

function tempStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-task-events-'));
  return { dir, file: path.join(dir, 'events.json') };
}

test('TaskEventStore keeps acknowledgements independent for each IDE client', () => {
  const store = new TaskEventStore({ persistencePath: null });
  const first = store.append({ type: 'task.completed', taskId: 'task-1', status: 'done' });
  store.append({ type: 'task.error', taskId: 'task-2', status: 'error' });

  store.ack('ide-a', first.eventId);

  assert.deepStrictEqual(store.list({ clientId: 'ide-a' }).events.map(event => event.taskId), ['task-2']);
  assert.deepStrictEqual(store.list({ clientId: 'ide-b' }).events.map(event => event.taskId), ['task-1', 'task-2']);
});

test('TaskEventStore reloads events and client cursors after restart', () => {
  const target = tempStorePath();
  try {
    const firstStore = new TaskEventStore({ persistencePath: target.file });
    const event = firstStore.append({ type: 'task.completed', taskId: 'task-persisted', status: 'done' });
    firstStore.ack('codex', event.eventId);

    const restarted = new TaskEventStore({ persistencePath: target.file });
    assert.deepStrictEqual(restarted.list({ clientId: 'codex' }).events, []);
    assert.deepStrictEqual(restarted.list({ clientId: 'other-ide' }).events.map(item => item.taskId), ['task-persisted']);
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

asyncTest('TaskEventStore wait resolves when a new event is appended', async () => {
  const store = new TaskEventStore({ persistencePath: null });
  const waiting = store.wait({ clientId: 'cursor', timeoutMs: 1000 });
  setTimeout(() => {
    store.append({ type: 'task.approval_required', taskId: 'task-needs-input', status: 'approval_required' });
  }, 10);

  const result = await waiting;
  assert.strictEqual(result.events.length, 1);
  assert.strictEqual(result.events[0].taskId, 'task-needs-input');
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (r.failed > 0) process.exitCode = 1;
})();
