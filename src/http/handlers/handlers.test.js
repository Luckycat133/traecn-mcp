'use strict';

/**
 * Tests for the per-topic handler modules in src/http/handlers/.
 *
 * Each handler file exports a ROUTES slice plus named handleX functions.
 * These tests verify:
 *   - the module loads and exposes the expected exports
 *   - the ROUTES slice doesn't overlap with another slice
 *   - the combined slice matches the central route-table
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROUTES: CENTRAL_ROUTES, matchRoute } = require('../route-table');
const { createRunner } = require('../../shared/test-runner');
const runner = createRunner('handlers.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[handlers.test.js] Running handler module tests...\n');

const HANDLERS_DIR = __dirname;

function findModule(name) {
  return require(path.join(HANDLERS_DIR, name));
}

test('handlers: status module loads and exposes ROUTES', () => {
  const mod = findModule('status');
  assert.ok(Array.isArray(mod.ROUTES));
  assert.ok(mod.ROUTES.length >= 5);
  assert.strictEqual(typeof mod.handleStatus, 'function');
  assert.strictEqual(typeof mod.handleMetrics, 'function');
});

test('handlers: tasks module loads and exposes ROUTES', () => {
  const mod = findModule('tasks');
  assert.ok(Array.isArray(mod.ROUTES));
  assert.ok(mod.ROUTES.length >= 4, 'tasks module owns history/clear/getTask/replay');
  assert.strictEqual(typeof mod.handleTasksHistory, 'function');
});

test('handlers: delegate module loads and exposes handleDelegateAsync', () => {
  const mod = findModule('delegate');
  assert.strictEqual(typeof mod.handleDelegateAsync, 'function');
  assert.ok(Array.isArray(mod.ROUTES));
  assert.ok(mod.ROUTES.length >= 3, 'delegate owns /api/tasks/delegate + /api/delegate + /api/delegate-async');
});

test('handlers: sessions module loads and exposes ROUTES', () => {
  const mod = findModule('sessions');
  assert.strictEqual(typeof mod.handleDelegate, 'function');
});

test('handlers: combined ROUTES slice matches the central route-table', () => {
  // Compose every handler module's ROUTES slice.
  const composed = [];
  for (const file of fs.readdirSync(HANDLERS_DIR)) {
    if (!file.endsWith('.js') || file === 'handlers.test.js' || file.endsWith('.test.js')) continue;
    const mod = require(path.join(HANDLERS_DIR, file));
    if (Array.isArray(mod.ROUTES)) composed.push(...mod.ROUTES);
  }
  // Every composed route must already exist in the central ROUTES table.
  for (const route of composed) {
    const found = CENTRAL_ROUTES.find(r => r.method === route.method && r.path === route.path);
    assert.ok(found, `route ${route.method} ${route.path} not registered in route-table.js`);
    for (const field of ['handler', 'requiresAuth', 'requiresRateLimit', 'requiresBody', 'debugOnly']) {
      assert.deepStrictEqual(
        found[field],
        route[field],
        `route ${route.method} ${route.path} field ${field} differs from route-table.js`
      );
    }
  }
});

test('handlers: status module routes resolve via matchRoute', () => {
  const mod = findModule('status');
  for (const route of mod.ROUTES) {
    const sample = route.path.replace(/:[a-zA-Z]+/g, 'sample');
    const result = matchRoute(route.method, sample);
    assert.ok(result, `status route ${route.method} ${route.path} did not match`);
  }
});

test('handlers: tasks module routes resolve via matchRoute', () => {
  const mod = findModule('tasks');
  for (const route of mod.ROUTES) {
    const sample = route.path.replace(/:[a-zA-Z]+/g, 'sample');
    const result = matchRoute(route.method, sample);
    assert.ok(result, `tasks route ${route.method} ${route.path} did not match`);
  }
});

test('task history and replay responses keep the final result without exposing stored trace', () => {
  const { handleGetTask, handleTaskReplay } = findModule('tasks');
  const result = { text: 'final answer', stable: true, traceText: 'captured private process' };
  const record = { taskId: 'trace_owner', status: 'completed', result };
  for (const handle of [handleGetTask, handleTaskReplay]) {
    let body;
    handle({}, {}, {
      taskHistoryStore: { getTask: () => record, getReplay: () => record },
      _json(_req, _res, value) { body = value; }
    }, record.taskId);
    assert.strictEqual(body.taskId, record.taskId);
    assert.deepStrictEqual(body.result, { text: 'final answer', stable: true });
    assert.strictEqual(record.result.traceText, 'captured private process');
  }
});

test('batch status keeps final results without exposing captured task traces', () => {
  const { handleBatchStatus } = findModule('batch');
  const result = { text: 'batch final answer', stable: true, traceText: 'batch process' };
  const batch = { batchId: 'batch_trace', status: 'completed', tasks: [{ taskId: 'batch_task', status: 'done', result }] };
  let body;
  handleBatchStatus({}, {}, {
    batchTasks: new Map([[batch.batchId, batch]]),
    _json(_req, _res, value) { body = value; }
  }, batch.batchId);
  assert.deepStrictEqual(body.tasks[0].result, { text: 'batch final answer', stable: true });
  assert.strictEqual(result.traceText, 'batch process');
});

test('history clear rejects invalid filters before reaching the history store', () => {
  const { handleTasksHistoryClear } = findModule('tasks');
  const invalid = [
    'olderThanHours=', 'olderThanHours=NaN', 'olderThanHours=-1', 'olderThanHours=1junk',
    'olderThanHours=1.5', 'olderThanHours=Infinity', 'olderThanHours=9007199254740992',
    'olderThanHours=9007199254740991', 'status=', 'beforeDate=', 'beforeDate=not-a-date'
  ];
  for (const query of invalid) {
    const req = { url: `/api/tasks/history?${query}`, headers: { host: 'localhost' } };
    const res = {};
    let clearCalls = 0;
    handleTasksHistoryClear(req, res, {
      taskHistoryStore: { clearHistory() { clearCalls++; return { deleted: 100 }; } },
      _json(_req, _res, body, status = 200) { res.body = body; res.status = status; }
    });
    assert.strictEqual(res.status, 400, query);
    assert.strictEqual(clearCalls, 0, query);
  }
});

test('history clear preserves combined, zero-age and explicit unfiltered requests', () => {
  const { handleTasksHistoryClear } = findModule('tasks');
  const cases = [
    ['?olderThanHours=24&status=completed&beforeDate=2026-10-01', {
      olderThanHours: 24, status: 'completed', beforeDate: '2026-10-01'
    }],
    ['?olderThanHours=0&status=completed', { olderThanHours: 0, status: 'completed', beforeDate: null }],
    ['', { olderThanHours: null, status: null, beforeDate: null }]
  ];
  for (const [query, expected] of cases) {
    const req = { url: `/api/tasks/history${query}`, headers: { host: 'localhost' } };
    const res = {};
    let seen;
    handleTasksHistoryClear(req, res, {
      taskHistoryStore: { clearHistory(options) { seen = options; return { deleted: 2 }; } },
      _json(_req, _res, body, status = 200) { res.body = body; res.status = status; }
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(seen, expected);
    assert.deepStrictEqual(res.body, { success: true, deleted: 2 });
  }
});

test('OpenAPI documents history-clear filter intersection and invalid-filter refusal', () => {
  const { generateOpenAPISpec } = require('../openapi');
  const operation = generateOpenAPISpec().paths['/api/tasks/history'].delete;
  assert.match(operation.description, /all provided filters/);
  assert.ok(operation.responses['400']);
  const age = operation.parameters.find(parameter => parameter.name === 'olderThanHours');
  assert.strictEqual(age.schema.minimum, 0);
  assert.strictEqual(age.schema.maximum, Math.floor(Number.MAX_SAFE_INTEGER / 3600000));
});

// ── Queue-probe guard (regression test for "wait for Trae queue" spam) ──
const { handleDelegateAsync } = require('./delegate');
const { handleSubmitSoloChatTask, handleCleanupForeignQueue } = require('./solo-chat');
const { handleDelegate: handleSessionDelegate } = require('./sessions');
const { handleBatchSubmit } = require('./batch');
const { handleStopGeneration } = require('./trae-control');
const { isGenericQueueProbeTask } = require('../../shared/utils');

function jsonReq(body) {
  return require('stream').Readable.from([Buffer.from(JSON.stringify(body))]);
}

function fakeCtx() {
  return {
    _assertProjectWorkspace: async () => null,
    _json: (req, res, body, status) => { res.status = status; res.body = body; return res; }
  };
}

asyncTest('handleDelegateAsync rejects "wait for Trae queue" with 400', async () => {
  const req = jsonReq({ task: 'wait for Trae queue' });
  const res = {};
  const ctx = fakeCtx();
  await handleDelegateAsync(req, res, ctx);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'generic_queue_probe_task_rejected');
});

asyncTest('handleDelegateAsync with chatId sends OpenClaw notification', async () => {
  const originalFetch = global.fetch;
  let capturedNotification = null;
  global.fetch = async (url, options) => {
    capturedNotification = { url, body: JSON.parse(options.body) };
    return { ok: true, text: async () => '' };
  };

  const req = jsonReq({ task: 'say hello', chatId: 'chat-123' });
  const res = {};
  const timeoutIds = new Set();
  const ctx = {
    ...fakeCtx(),
    mockBridge: true,
    _normalizeFallbackModels: () => [],
    _modelProbeIntervalMs: () => 60000,
    _ensureConnection: async () => {},
    _setTimeout: (cb, delay) => {
      const id = setTimeout(cb, delay);
      timeoutIds.add(id);
      return id;
    },
    _clearTimeout: id => {
      clearTimeout(id);
      timeoutIds.delete(id);
    },
    _isSuccessfulResult: result => result && result.stable === true,
    _normalizeFollowupTasks: () => [],
    _storeIdempotency: () => {},
    driver: {
      checkQueueStatus: async () => ({ queued: false, running: false, canSubmit: true }),
      delegate: async () => ({ text: 'hello from Trae', stable: true, elapsedMs: 12 })
    }
  };

  try {
    req.headers = {};
    await handleDelegateAsync(req, res, ctx);
  } finally {
    global.fetch = originalFetch;
    for (const id of timeoutIds) clearTimeout(id);
  }

  assert.strictEqual(res.status, undefined);
  assert.strictEqual(res.body.status, 'done');
  assert.ok(capturedNotification, 'expected OpenClaw notification');
  assert.strictEqual(capturedNotification.body.chatId, 'chat-123');
  assert.ok(capturedNotification.body.text.includes('hello from Trae'));
});

asyncTest('handleSubmitSoloChatTask rejects "Wait for Trae Queue 进行中 17:34" with 400', async () => {
  const req = jsonReq({ task: 'Wait for Trae Queue 进行中 17:34' });
  const res = {};
  const ctx = fakeCtx();
  await handleSubmitSoloChatTask(req, res, ctx);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'generic_queue_probe_task_rejected');
});

asyncTest('handleSessionDelegate rejects layered queue probes', async () => {
  const req = jsonReq({ task: '现在已经排到了' });
  const res = {};
  const ctx = fakeCtx();
  await handleSessionDelegate(req, res, ctx, 'test-session');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'generic_queue_probe_task_rejected');
});

asyncTest('handleBatchSubmit rejects a batch containing a queue-probe task', async () => {
  const req = jsonReq({ tasks: [{ task: 'real work' }, { task: 'wait for Trae queue' }] });
  const res = {};
  const ctx = fakeCtx();
  await handleBatchSubmit(req, res, ctx);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'generic_queue_probe_task_rejected');
  assert.strictEqual(res.body.offendingIndex, 1);
});

asyncTest('handleDelegateAsync still accepts legitimate tasks (regression: not over-blocking)', async () => {
  const req = jsonReq({ task: 'implement the queue status panel without sending prompts' });
  const res = {};
  const ctx = {
    _json: (req, res, body, status) => { res.status = status; res.body = body; return res; },
    // The handler will reach ctx.driver.checkQueueStatus() — make it throw
    // so the request fails for an unrelated reason, but never with
    // 'generic_queue_probe_task_rejected'.
    _ensureConnection: async () => { throw new Error('not_connected_for_test'); },
    _normalizeFallbackModels: () => [],
    _modelProbeIntervalMs: () => 15000
  };
  await handleDelegateAsync(req, res, ctx).catch(() => {});
  assert.notStrictEqual(res.body && res.body.error, 'generic_queue_probe_task_rejected');
});

test('isGenericQueueProbeTask detects the canonical probe string', () => {
  assert.strictEqual(isGenericQueueProbeTask('wait for Trae queue'), true);
  assert.strictEqual(isGenericQueueProbeTask('Wait for Trae Queue 进行中 17:34'), true);
  assert.strictEqual(isGenericQueueProbeTask('Please implement a queue-status panel'), false);
  assert.strictEqual(isGenericQueueProbeTask('implement a queue-status panel without sending prompts'), false);
});

asyncTest('handleStopGeneration requires a scoped active conversation and audit reason', async () => {
  let stopped = false;
  const auditEntries = [];
  const ctx = {
    _ensureConnection: async () => {},
    _json: (_req, res, body, status = 200) => { res.status = status; res.body = body; return res; },
    driver: {
      detectMode: async () => ({ mode: 'solo' }),
      listSoloChats: async () => ({ chats: [
        { index: 0, title: 'Current task', active: true },
        { index: 1, title: 'Other task', active: false }
      ] }),
      stopGeneration: async () => { stopped = true; return { success: true }; }
    },
    auditLogger: { log: entry => auditEntries.push(entry) }
  };

  const wrongRes = {};
  await handleStopGeneration(jsonReq({
    conversationId: 'solo:T3RoZXIgdGFzaw',
    acknowledgeUntrackedWork: true,
    reason: 'Stop requested by user'
  }), wrongRes, ctx);
  assert.strictEqual(wrongRes.status, 409);
  assert.strictEqual(wrongRes.body.error, 'active_conversation_mismatch');
  assert.strictEqual(stopped, false);

  const unacknowledgedRes = {};
  await handleStopGeneration(jsonReq({
    conversationId: 'solo:Q3VycmVudCB0YXNr',
    reason: 'Stop requested by user'
  }), unacknowledgedRes, ctx);
  assert.strictEqual(unacknowledgedRes.status, 400);
  assert.strictEqual(unacknowledgedRes.body.error, 'untracked_work_acknowledgement_required');

  const successRes = {};
  await handleStopGeneration(jsonReq({
    conversationId: 'solo:Q3VycmVudCB0YXNr',
    acknowledgeUntrackedWork: true,
    reason: 'Stop requested by user'
  }), successRes, ctx);
  assert.strictEqual(successRes.status, 200);
  assert.strictEqual(successRes.body.success, true);
  assert.strictEqual(successRes.body.conversationId, 'solo:Q3VycmVudCB0YXNr');
  assert.strictEqual(stopped, true);
  assert.strictEqual(auditEntries.at(-1).action, 'trae.stop_generation');
});

asyncTest('scoped stop preserves legacy IDs and never falls back from a native ID', async () => {
  let stopped = 0;
  const chats = [
    { index: 0, sessionId: 'native-current', title: 'Current task 任务中断 09:53', active: true },
    { index: 1, sessionId: 'native-other', title: 'Other task', active: false }
  ];
  const ctx = {
    _ensureConnection: async () => {},
    _json: (_req, res, body, status = 200) => Object.assign(res, { status, body }),
    driver: {
      detectMode: async () => ({ mode: 'solo' }),
      listSoloChats: async () => ({ chats }),
      stopGeneration: async () => { stopped++; return { success: true }; }
    }
  };
  const stop = async conversationId => {
    const response = {};
    await handleStopGeneration(jsonReq({ conversationId, acknowledgeUntrackedWork: true,
      reason: 'Cancel the owned test conversation' }), response, ctx);
    return response;
  };
  assert.strictEqual((await stop('solo-session:native-other')).status, 409);
  assert.strictEqual((await stop('solo-session:native-missing')).status, 409);
  assert.strictEqual(stopped, 0);
  assert.strictEqual((await stop('solo-session:native-current')).status, 200);
  assert.strictEqual((await stop('solo:Q3VycmVudCB0YXNr')).status, 200);
  assert.strictEqual((await stop('solo:0')).status, 200);
  chats.push({ index: 2, sessionId: 'same-title-other', title: 'Current task', active: false });
  assert.strictEqual((await stop('solo:Q3VycmVudCB0YXNr')).status, 409);
  assert.strictEqual(stopped, 3);
});

asyncTest('handleCleanupForeignQueue dry-run lists queue-probe Solo chats without deleting', async () => {
  let deleted = false;
  const req = jsonReq({ dryRun: true });
  const res = {};
  const ctx = {
    client: { isConnected: true },
    _ensureConnection: async () => {},
    _json: (req, res, body, status) => { res.status = status; res.body = body; return res; },
    driver: {
      listSoloChats: async () => ({
        mode: 'solo',
        chats: [
          { index: 0, title: 'normal feature work', text: 'implementation notes' },
          { index: 1, title: 'wait for Trae queue', text: '排队中 ...' }
        ],
        count: 2
      }),
      deleteSoloChats: async () => { deleted = true; return { deleted: 1 }; }
    }
  };

  await handleCleanupForeignQueue(req, res, ctx);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.matched, 1);
  assert.strictEqual(res.body.deleted, 0);
  assert.strictEqual(res.body.dryRun, true);
  assert.strictEqual(res.body.support, 'delete_supported');
  assert.strictEqual(res.body.candidates[0].index, 1);
  assert.strictEqual(deleted, false);
});

asyncTest('handleCleanupForeignQueue execute deletes matched queue-probe chats', async () => {
  const seenCandidates = [];
  const req = jsonReq({ execute: true });
  const res = {};
  const ctx = {
    client: { isConnected: true },
    _ensureConnection: async () => {},
    _json: (req, res, body, status) => { res.status = status; res.body = body; return res; },
    driver: {
      listSoloChats: async () => ({
        mode: 'solo',
        chats: [{ index: 0, title: 'Wait for Trae Queue 进行中 17:34', text: '' }],
        count: 1
      }),
      deleteSoloChats: async ({ candidates }) => {
        seenCandidates.push(...candidates);
        return { deleted: candidates.length, attempts: [{ success: true }] };
      }
    }
  };

  await handleCleanupForeignQueue(req, res, ctx);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.deleted, 1);
  assert.strictEqual(res.body.dryRun, false);
  assert.strictEqual(res.body.passes.length, 1);
  assert.strictEqual(seenCandidates[0].title, 'Wait for Trae Queue 进行中 17:34');
});

asyncTest('handleCleanupForeignQueue execute returns 501 when deletion is unsupported', async () => {
  const req = jsonReq({ execute: true });
  const res = {};
  const ctx = {
    client: { isConnected: true },
    _ensureConnection: async () => {},
    _json: (req, res, body, status) => { res.status = status; res.body = body; return res; },
    driver: {
      listSoloChats: async () => ({
        mode: 'solo',
        chats: [{ index: 0, title: 'wait for Trae queue', text: '' }],
        count: 1
      })
    }
  };

  await handleCleanupForeignQueue(req, res, ctx);

  assert.strictEqual(res.status, 501);
  assert.strictEqual(res.body.code, 'DRIVER_METHOD_MISSING');
  assert.strictEqual(res.body.candidates[0].title, 'wait for Trae queue');
});

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
});
