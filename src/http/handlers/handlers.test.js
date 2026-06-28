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

summary();
if (runner.failed > 0) process.exit(1);