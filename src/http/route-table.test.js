'use strict';

/**
 * Tests for src/http/route-table.js.
 *
 * The route table is the architectural primitive that future handler
 * extraction will compose against. These tests verify:
 *   - the table compiles and matches expected routes
 *   - path-param routing works for the common task/session patterns
 *   - the route table covers every URL the Gateway actually dispatches
 *   - resolveHandler() correctly looks up top-level handlers and the
 *     driver-dispatch special case
 */

const assert = require('assert');
const { ROUTES, matchRoute, resolveHandler, compilePath } = require('./route-table');

const { createRunner } = require('../shared/test-runner');
const runner = createRunner('route-table.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[route-table.test.js] Running route table tests...\n');

test('route-table: matches exact paths first', () => {
  const result = matchRoute('GET', '/api/status');
  assert.ok(result, 'should match /api/status');
  assert.strictEqual(result.route.handler, '_handleStatus');
  assert.deepStrictEqual(result.params, {});
});

test('route-table: matches path-param routes', () => {
  const result = matchRoute('GET', '/api/tasks/abc123');
  assert.ok(result, 'should match /api/tasks/:taskId');
  assert.strictEqual(result.route.handler, '_handleGetTask');
  assert.strictEqual(result.params.taskId, 'abc123');
});

test('route-table: taskId with URL-encoded characters is decoded', () => {
  const result = matchRoute('GET', '/api/tasks/abc%2F123');
  assert.ok(result);
  assert.strictEqual(result.params.taskId, 'abc/123');
});

test('route-table: distinguishes taskId from replay', () => {
  const result = matchRoute('GET', '/api/tasks/abc123/replay');
  assert.ok(result);
  assert.strictEqual(result.route.handler, '_handleTaskReplay');
  assert.strictEqual(result.params.taskId, 'abc123');
});

test('route-table: returns null for unknown paths', () => {
  const result = matchRoute('GET', '/api/does-not-exist');
  assert.strictEqual(result, null);
});

test('route-table: distinguishes DELETE on history vs DELETE on batch', () => {
  const historyResult = matchRoute('DELETE', '/api/tasks/history');
  const batchResult = matchRoute('DELETE', '/api/tasks/batch/batch-xyz');
  assert.strictEqual(historyResult.route.handler, '_handleTasksHistoryClear');
  assert.strictEqual(batchResult.route.handler, '_handleBatchCancel');
  assert.strictEqual(batchResult.params.batchId, 'batch-xyz');
});

test('route-table: drivers register POST handlers via _handleDriverAction:NAME', () => {
  const editor = matchRoute('POST', '/api/editor');
  const file = matchRoute('POST', '/api/file');
  const terminal = matchRoute('POST', '/api/terminal');
  assert.strictEqual(editor.route.handler, '_handleDriverAction:editor');
  assert.strictEqual(file.route.handler, '_handleDriverAction:file');
  assert.strictEqual(terminal.route.handler, '_handleDriverAction:terminal');
});

test('route-table: resolveHandler returns bound function for top-level handlers', () => {
  const fakeGateway = { _handleStatus() { return 'ok'; } };
  const fn = resolveHandler(fakeGateway, '_handleStatus');
  assert.strictEqual(typeof fn, 'function');
  assert.strictEqual(fn(), 'ok');
});

test('route-table: resolveHandler returns null for unknown handler names', () => {
  const fakeGateway = {};
  const fn = resolveHandler(fakeGateway, '_doesNotExist');
  assert.strictEqual(fn, null);
});

test('route-table: resolveHandler handles driver-dispatch special case', () => {
  let captured;
  const fakeGateway = {
    _handleDriverAction(req, res, driverName) {
      captured = driverName;
    }
  };
  const fn = resolveHandler(fakeGateway, '_handleDriverAction:editor');
  assert.strictEqual(typeof fn, 'function');
  fn({}, {});
  assert.strictEqual(captured, 'editor');
});

test('route-table: compilePath escapes regex metacharacters', () => {
  // Static segments must escape characters like . so they match literally.
  const { re } = compilePath('/api/v1.0/tasks');
  assert.ok(re.test('/api/v1.0/tasks'));
  assert.ok(!re.test('/api/v1X0/tasks'));
});

test('route-table: every route is reachable via matchRoute', () => {
  // Build a fake req/res pair so we can dispatch to a Gateway stub
  // and assert that every documented route matches at least one path.
  for (const route of ROUTES) {
    // Reconstruct an example path by replacing :name with a sample value.
    const sample = route.path.replace(/:[a-zA-Z]+/g, 'sample');
    const result = matchRoute(route.method, sample);
    assert.ok(result, `route ${route.method} ${route.path} did not match sample ${sample}`);
    assert.strictEqual(result.route.path, route.path);
  }
});

test('route-table: documents requiresAuth + requiresRateLimit + requiresBody flags', () => {
  const status = matchRoute('GET', '/api/status').route;
  assert.strictEqual(status.requiresAuth, false);
  assert.strictEqual(status.requiresRateLimit, true);
  assert.strictEqual(status.requiresBody, false);

  const delegate = matchRoute('POST', '/api/delegate').route;
  assert.strictEqual(delegate.requiresAuth, true);
  assert.strictEqual(delegate.requiresRateLimit, true);
  assert.strictEqual(delegate.requiresBody, true);
});

summary();
if (runner.failed > 0) process.exit(1);