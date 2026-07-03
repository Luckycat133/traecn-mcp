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
    assert.strictEqual(found.handler, route.handler);
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

// ── Queue-probe guard (regression test for "wait for Trae queue" spam) ──
const { handleDelegateAsync } = require('./delegate');
const { handleSubmitSoloChatTask, handleCleanupForeignQueue } = require('./solo-chat');
const { handleDelegate: handleSessionDelegate } = require('./sessions');
const { handleBatchSubmit } = require('./batch');
const { isGenericQueueProbeTask } = require('../../shared/utils');

function jsonReq(body) {
  return require('stream').Readable.from([Buffer.from(JSON.stringify(body))]);
}

function fakeCtx() {
  return {
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
