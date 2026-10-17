'use strict';

const assert = require('assert');
const crypto = require('crypto');
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

function documentChecksum(document) {
  const payload = {
    schemaVersion: document.schemaVersion,
    savedAt: document.savedAt,
    sequence: document.sequence,
    acknowledged: document.acknowledged,
    events: document.events
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

test('TaskEventStore preserves old pretty snapshots and checksummed Unicode data through compact writes', () => {
  const target = tempStorePath();
  try {
    const first = {
      eventId: 'evt_1', type: 'task.completed', taskId: '旧任务', status: 'done',
      createdAt: '2026-10-02T00:00:00.000Z', summary: '旧结果：引号 "、换行\n和反斜杠 \\',
      terminal: true, attentionRequired: false, resultAvailable: true, sessionId: null
    };
    const oldDocument = {
      schemaVersion: 2, savedAt: '2026-10-02T00:00:00.000Z', sequence: 1,
      acknowledged: { codex: 'evt_1' }, events: [first]
    };
    oldDocument.checksum = { algorithm: 'sha256', digest: documentChecksum(oldDocument) };
    const oldBytes = `${JSON.stringify(oldDocument, null, 2)}\n`;
    fs.writeFileSync(target.file, oldBytes);
    const phases = [];
    const store = new TaskEventStore({ persistencePath: target.file, onWritePhase: phase => phases.push(phase) });
    assert.deepStrictEqual(store.list({ clientId: 'other' }).events, [first]);
    assert.strictEqual(store.list({ clientId: 'codex' }).acknowledgedCursor, 'evt_1');
    const appended = store.append({
      taskId: '新任务', type: 'task.approval_required', status: 'approval_required',
      interactionRequestId: '审批-2', attentionRequired: true,
      summary: 'Unicode 🐈；"checksum":{}；换行\n反斜杠\\与结束符 }'
    });
    assert.ok(appended);
    const bytes = fs.readFileSync(target.file, 'utf8');
    const document = JSON.parse(bytes);
    assert.strictEqual(document.schemaVersion, 2);
    assert.strictEqual(document.checksum.digest, documentChecksum(document));
    assert.deepStrictEqual(document.events, [first, appended]);
    assert.strictEqual(fs.readFileSync(`${target.file}.bak`, 'utf8'), oldBytes);
    assert.deepStrictEqual(phases, [
      'temp_opened', 'temp_written', 'temp_fsynced', 'backup_committed',
      'primary_committed', 'directory_fsynced'
    ]);
    const restarted = new TaskEventStore({ persistencePath: target.file });
    assert.deepStrictEqual(restarted.list({ clientId: 'codex' }).events, [appended]);
    assert.strictEqual(restarted.getHealth().durabilityDegraded, false);
  } finally { fs.rmSync(target.dir, { recursive: true, force: true }); }
});

test('TaskEventStore keeps acknowledgements independent for each IDE client', () => {
  const store = new TaskEventStore({ persistencePath: null });
  const first = store.append({ type: 'task.completed', taskId: 'task-1', status: 'done' });
  store.append({ type: 'task.error', taskId: 'task-2', status: 'error' });

  store.ack('ide-a', first.eventId);

  assert.deepStrictEqual(store.list({ clientId: 'ide-a' }).events.map(event => event.taskId), ['task-2']);
  assert.deepStrictEqual(store.list({ clientId: 'ide-b' }).events.map(event => event.taskId), ['task-1', 'task-2']);
});

test('TaskEventStore identifies new clients without discarding durable resume cursors', () => {
  const store = new TaskEventStore({ persistencePath: null });
  const first = store.append({ type: 'task.completed', taskId: 'task-1', status: 'done' });

  const newClient = store.list({ clientId: 'new-client' });
  assert.strictEqual(newClient.clientKnown, false);
  assert.strictEqual(newClient.acknowledgedCursor, null);

  store.ack('returning-client', first.eventId);
  const returningClient = store.list({ clientId: 'returning-client' });
  assert.strictEqual(returningClient.clientKnown, true);
  assert.strictEqual(returningClient.acknowledgedCursor, first.eventId);
});

test('TaskEventStore computes hasMore from the effective cursor', () => {
  const store = new TaskEventStore({ persistencePath: null });
  const first = store.append({ type: 'task.completed', taskId: 'task-1', status: 'done' });
  const second = store.append({ type: 'task.completed', taskId: 'task-2', status: 'done' });

  const firstPage = store.list({ clientId: 'paged', limit: 1 });
  assert.deepStrictEqual(firstPage.events.map(event => event.taskId), ['task-1']);
  assert.strictEqual(firstPage.cursor, first.eventId);
  assert.strictEqual(firstPage.hasMore, true);

  const exhaustedByCursor = store.list({ clientId: 'paged', after: second.eventId });
  assert.deepStrictEqual(exhaustedByCursor.events, []);
  assert.strictEqual(exhaustedByCursor.cursor, second.eventId);
  assert.strictEqual(exhaustedByCursor.hasMore, false);

  store.ack('acked', second.eventId);
  const exhaustedByAcknowledgement = store.list({ clientId: 'acked' });
  assert.deepStrictEqual(exhaustedByAcknowledgement.events, []);
  assert.strictEqual(exhaustedByAcknowledgement.cursor, second.eventId);
  assert.strictEqual(exhaustedByAcknowledgement.hasMore, false);
});

test('TaskEventStore accepts an acknowledged cursor after its event was pruned', () => {
  const store = new TaskEventStore({ persistencePath: null, maxEvents: 2 });
  const first = store.append({ type: 'task.completed', taskId: 'task-1', status: 'done' });
  store.append({ type: 'task.completed', taskId: 'task-2', status: 'done' });
  store.append({ type: 'task.completed', taskId: 'task-3', status: 'done' });

  assert.deepStrictEqual(store.list({ clientId: 'slow-client' }).events.map(event => event.taskId), ['task-2', 'task-3']);
  const acknowledgement = store.ack('slow-client', first.eventId);
  assert.deepStrictEqual(acknowledgement, {
    acknowledged: true,
    clientId: 'slow-client',
    eventId: first.eventId
  });

  store.append({ type: 'task.completed', taskId: 'task-4', status: 'done' });
  assert.deepStrictEqual(store.list({ clientId: 'slow-client' }).events.map(event => event.taskId), ['task-3', 'task-4']);
});

test('TaskEventStore does not let an unknown future cursor stall later events', () => {
  const store = new TaskEventStore({ persistencePath: null });
  const before = store.list({ clientId: 'future-client', after: 'evt_999' });
  assert.deepStrictEqual(before.events, []);
  assert.strictEqual(before.cursor, null);

  store.append({ type: 'task.completed', taskId: 'task-after-future-cursor', status: 'done' });
  const after = store.list({ clientId: 'future-client', after: 'evt_999' });
  assert.deepStrictEqual(after.events.map(event => event.taskId), ['task-after-future-cursor']);
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

test('TaskEventStore persists client IDs that also name object prototype properties', () => {
  const target = tempStorePath();
  try {
    const store = new TaskEventStore({ persistencePath: target.file });
    const first = store.append({ type: 'task.completed', taskId: 'task-first', status: 'done' });
    store.append({ type: 'task.completed', taskId: 'task-second', status: 'done' });
    for (const clientId of ['__proto__', 'constructor', 'toString']) {
      assert.deepStrictEqual(store.ack(clientId, first.eventId), {
        acknowledged: true,
        clientId,
        eventId: first.eventId
      });
    }

    const restarted = new TaskEventStore({ persistencePath: target.file });
    for (const clientId of ['__proto__', 'constructor', 'toString']) {
      const page = restarted.list({ clientId });
      assert.strictEqual(page.clientKnown, true);
      assert.strictEqual(page.acknowledgedCursor, first.eventId);
      assert.deepStrictEqual(page.events.map(event => event.taskId), ['task-second']);
    }
    assert.deepStrictEqual(restarted.list({ clientId: 'another-client' }).events.map(event => event.taskId), [
      'task-first', 'task-second'
    ]);
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('TaskEventStore preserves a pruned client cursor across restart', () => {
  const target = tempStorePath();
  try {
    const firstStore = new TaskEventStore({ persistencePath: target.file, maxEvents: 2 });
    const first = firstStore.append({ type: 'task.completed', taskId: 'task-pruned-1', status: 'done' });
    firstStore.append({ type: 'task.completed', taskId: 'task-pruned-2', status: 'done' });
    firstStore.append({ type: 'task.completed', taskId: 'task-pruned-3', status: 'done' });
    assert.strictEqual(firstStore.ack('slow-client', first.eventId).acknowledged, true);

    const restarted = new TaskEventStore({ persistencePath: target.file, maxEvents: 2 });
    restarted.append({ type: 'task.completed', taskId: 'task-pruned-4', status: 'done' });
    assert.deepStrictEqual(
      restarted.list({ clientId: 'slow-client' }).events.map(event => event.taskId),
      ['task-pruned-3', 'task-pruned-4']
    );
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('TaskEventStore writes checksummed snapshots atomically and preserves a backup', () => {
  const target = tempStorePath();
  try {
    const store = new TaskEventStore({ persistencePath: target.file });
    store.append({ type: 'task.completed', taskId: 'task-first', status: 'done' });
    store.append({ type: 'task.completed', taskId: 'task-second', status: 'done' });

    const primary = JSON.parse(fs.readFileSync(target.file, 'utf8'));
    const backup = JSON.parse(fs.readFileSync(`${target.file}.bak`, 'utf8'));
    assert.strictEqual(primary.schemaVersion, 2);
    assert.strictEqual(primary.checksum.algorithm, 'sha256');
    assert.strictEqual(primary.checksum.digest, documentChecksum(primary));
    assert.deepStrictEqual(primary.events.map(event => event.taskId), ['task-first', 'task-second']);
    assert.deepStrictEqual(backup.events.map(event => event.taskId), ['task-first']);
    assert.strictEqual(fs.existsSync(`${target.file}.tmp`), false);
    assert.strictEqual(fs.existsSync(`${target.file}.bak.tmp`), false);
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('TaskEventStore quarantines a corrupt primary and recovers the validated backup', () => {
  const target = tempStorePath();
  try {
    const store = new TaskEventStore({ persistencePath: target.file, logger: { error() {}, warn() {} } });
    store.append({ type: 'task.completed', taskId: 'task-backed-up', status: 'done' });
    store.append({ type: 'task.completed', taskId: 'task-primary-only', status: 'done' });
    fs.writeFileSync(target.file, '{"schemaVersion":2,"events":[', 'utf8');

    const restarted = new TaskEventStore({
      persistencePath: target.file,
      logger: { error() {}, warn() {} }
    });

    assert.deepStrictEqual(
      restarted.list({ clientId: 'recovery-client' }).events.map(event => event.taskId),
      ['task-backed-up']
    );
    assert.ok(fs.readdirSync(target.dir).some(name => name.startsWith('events.json.corrupt-')));
    assert.strictEqual(JSON.parse(fs.readFileSync(target.file, 'utf8')).schemaVersion, 2);
    assert.strictEqual(restarted.getHealth().lastRecovery.source, 'backup');
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('TaskEventStore migrates a legacy version 1 snapshot without losing cursors', () => {
  const target = tempStorePath();
  try {
    fs.writeFileSync(target.file, `${JSON.stringify({
      version: 1,
      savedAt: '2026-08-01T00:00:00.000Z',
      sequence: 7,
      acknowledged: { codex: 'evt_7' },
      events: [{
        eventId: 'evt_7',
        type: 'task.completed',
        taskId: 'task-legacy',
        status: 'done',
        createdAt: '2026-08-01T00:00:00.000Z',
        terminal: true,
        attentionRequired: false,
        resultAvailable: true,
        sessionId: null,
        summary: 'legacy event'
      }]
    }, null, 2)}\n`, 'utf8');

    const restarted = new TaskEventStore({ persistencePath: target.file });
    assert.deepStrictEqual(restarted.list({ clientId: 'codex' }).events, []);
    assert.deepStrictEqual(
      restarted.list({ clientId: 'other-client' }).events.map(event => event.taskId),
      ['task-legacy']
    );
    const migrated = JSON.parse(fs.readFileSync(target.file, 'utf8'));
    assert.strictEqual(migrated.schemaVersion, 2);
    assert.strictEqual(migrated.checksum.digest, documentChecksum(migrated));
    assert.strictEqual(restarted.getHealth().lastRecovery.source, 'legacy');
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('TaskEventStore recovers a complete interrupted temporary snapshot', () => {
  const target = tempStorePath();
  try {
    const store = new TaskEventStore({ persistencePath: target.file });
    store.append({ type: 'task.completed', taskId: 'task-temp', status: 'done' });
    fs.copyFileSync(target.file, `${target.file}.tmp`);
    fs.unlinkSync(target.file);

    const restarted = new TaskEventStore({ persistencePath: target.file });
    assert.deepStrictEqual(
      restarted.list({ clientId: 'temp-recovery' }).events.map(event => event.taskId),
      ['task-temp']
    );
    assert.strictEqual(restarted.getHealth().lastRecovery.source, 'temp');
    assert.strictEqual(fs.existsSync(target.file), true);
    assert.strictEqual(fs.existsSync(`${target.file}.tmp`), false);
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('TaskEventStore rolls back an append when the event snapshot cannot persist', () => {
  const target = tempStorePath();
  try {
    const blocker = path.join(target.dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'block persistence directory creation', 'utf8');
    const store = new TaskEventStore({
      persistencePath: path.join(blocker, 'events.json'),
      logger: { error() {}, warn() {} }
    });
    let appendSignals = 0;
    store.emitter.on('append', () => { appendSignals += 1; });

    const result = store.append({ type: 'task.completed', taskId: 'task-not-durable', status: 'done' });

    assert.strictEqual(result, null);
    assert.deepStrictEqual(store.list({ clientId: 'client' }).events, []);
    assert.strictEqual(store.sequence, 0);
    assert.strictEqual(appendSignals, 0);
    assert.strictEqual(store.getHealth().eventStoreWritable, false);
    assert.strictEqual(store.getHealth().durabilityDegraded, true);
    assert.ok(store.getHealth().lastPersistError);
  } finally {
    fs.rmSync(target.dir, { recursive: true, force: true });
  }
});

test('TaskEventStore does not claim an acknowledgement when cursor persistence fails', () => {
  const target = tempStorePath();
  let failWrites = false;
  try {
    const store = new TaskEventStore({
      persistencePath: target.file,
      logger: { error() {}, warn() {} },
      onWritePhase(phase) {
        if (failWrites && phase === 'temp_written') {
          const error = new Error('simulated event-store disk failure');
          error.code = 'ENOSPC';
          throw error;
        }
      }
    });
    const event = store.append({ type: 'task.completed', taskId: 'task-unacked', status: 'done' });
    failWrites = true;

    const result = store.ack('codex', event.eventId);

    assert.strictEqual(result.acknowledged, false);
    assert.strictEqual(result.error, 'TASK_EVENT_STORE_UNAVAILABLE');
    assert.deepStrictEqual(
      store.list({ clientId: 'codex' }).events.map(item => item.taskId),
      ['task-unacked']
    );
    assert.strictEqual(store.getHealth().eventStoreWritable, false);
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

asyncTest('TaskEventStore long-poll wakes for a new event after an unknown future cursor', async () => {
  const store = new TaskEventStore({ persistencePath: null });
  const waiting = store.wait({ clientId: 'future-long-poll', after: 'evt_999', timeoutMs: 1000 });
  setTimeout(() => {
    store.append({ type: 'task.completed', taskId: 'task-wakes-future-client', status: 'done' });
  }, 10);

  const result = await waiting;
  assert.deepStrictEqual(result.events.map(event => event.taskId), ['task-wakes-future-client']);
});

asyncTest('TaskEventStore wakes 32 concurrent clients without one emitter listener per client', async () => {
  const store = new TaskEventStore({ persistencePath: null });
  const waits = Array.from({ length: 32 }, (_, index) => store.wait({ clientId: `parallel-${index}`, timeoutMs: 1000 }));
  const listenerCount = store.emitter.listenerCount('append');
  const event = store.append({ type: 'task.completed', taskId: 'parallel-result', status: 'done' });
  const results = await Promise.all(waits);
  assert.strictEqual(results.length, 32);
  for (const result of results) assert.deepStrictEqual(result.events, [event]);
  assert.ok(listenerCount <= 1, `${listenerCount} append listeners for concurrent waits`);
  assert.strictEqual(store.emitter.listenerCount('append'), 0);
});

asyncTest('TaskEventStore abort releases one wait while other clients keep waiting', async () => {
  const store = new TaskEventStore({ persistencePath: null });
  const abortController = new AbortController();
  let abortedResult = null;
  const aborted = store.wait({ clientId: 'disconnected', signal: abortController.signal, timeoutMs: 1000 }).then(result => {
    abortedResult = result;
    return result;
  });
  const connected = store.wait({ clientId: 'connected', timeoutMs: 1000 });
  abortController.abort();
  await new Promise(resolve => setImmediate(resolve));
  const releasedBeforeAppend = abortedResult !== null;
  const event = store.append({ type: 'task.completed', taskId: 'connected-result', status: 'done' });
  await aborted;
  assert.deepStrictEqual((await connected).events, [event]);
  assert.strictEqual(releasedBeforeAppend, true);
  assert.deepStrictEqual(abortedResult.events, []);
  assert.strictEqual(store.emitter.listenerCount('append'), 0);
});

asyncTest('TaskEventStore pre-aborted wait does not register an append listener', async () => {
  const store = new TaskEventStore({ persistencePath: null });
  const abortController = new AbortController();
  abortController.abort();
  const waiting = store.wait({ clientId: 'already-disconnected', signal: abortController.signal, timeoutMs: 1000 });
  const listenerCount = store.emitter.listenerCount('append');
  if (listenerCount > 0) store.append({ type: 'task.completed', taskId: 'test-cleanup', status: 'done' });
  const result = await waiting;
  assert.strictEqual(listenerCount, 0);
  assert.deepStrictEqual(result.events, []);
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (r.failed > 0) process.exitCode = 1;
})();
