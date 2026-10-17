'use strict';

/**
 * Shared test-runner for the in-repo `*.test.js` files.
 *
 * Each `*.test.js` file used to duplicate ~20 lines of:
 *
 *     let passed = 0, failed = 0;
 *     function test(name, fn) { ... }
 *     function asyncTest(name, fn) { ... }
 *     // ... summary() and process.exit() ...
 *
 * This module collapses that boilerplate into a single factory so each
 * test file is just `createRunner('<file>')` plus the actual assertions.
 *
 * Typical usage:
 *
 *     const assert = require('assert');
 *     const { createRunner } = require('./test-runner');
 *     const r = createRunner('foo.test.js');
 *     const { test, asyncTest, pendingAsyncTests, summary } = r;
 *
 *     test('sync case', () => assert.strictEqual(1, 1));
 *     await asyncTest('async case', async () => { ... });
 *     // ... or call `await pendingAsyncTests()` after queuing ...
 *
 *     summary();
 *     if (r.failed > 0) process.exit(1);
 *
 * The runner intentionally does NOT call process.exit(). A handful of
 * test files (e.g. scripts/system-test.js) exit via their own cleanup,
 * and `npm test` runs every file in sequence with `&&`, so each file
 * MUST exit non-zero on failure on its own. An unsettled asynchronous case
 * also makes process exit fail, even if the event loop has no remaining work.
 *
 * `passed` / `failed` are exposed as live getters on the returned
 * runner, so callers can either reference `r.passed` after the fact,
 * or destructure the helpers and read `r.failed` at the end. (Plain
 * primitives would be snapshotted at destructure time.)
 */

const unsettledAsyncTests = new Set();

process.on('exit', () => {
  for (const pending of unsettledAsyncTests) {
    pending.fail();
    console.error(`  FAIL: [${pending.suiteName}] ${pending.name}: process exited before the test settled`);
  }
  if (unsettledAsyncTests.size > 0) process.exitCode = 1;
});

function createRunner(suiteName) {
  let passed = 0;
  let failed = 0;
  // Queue of async test tasks. Some test files push promises directly
  // and `await Promise.all(_pendingAsync)`; others call the higher-level
  // `asyncTest()` helper. We support both shapes.
  const _pendingAsync = [];

  function test(name, fn) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        return asyncTest(name, () => r);
      }
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL: ${name}: ${err.message}`);
    }
  }

  async function asyncTest(name, fn) {
    // Run inline (await the body) AND record the promise in the queue so
    // callers can either `await asyncTest(...)` for sequential ordering
    // or `await pendingAsyncTests()` to drain after queuing — both styles
    // are used in this repo's test files.
    const pending = { suiteName, name, fail: () => { failed++; } };
    unsettledAsyncTests.add(pending);
    const task = (async () => {
      try {
        await fn();
        passed++;
        console.log(`  PASS: ${name}`);
      } catch (err) {
        failed++;
        console.error(`  FAIL: ${name}: ${err.message}`);
        if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      } finally {
        unsettledAsyncTests.delete(pending);
      }
    })();
    _pendingAsync.push(task);
    return task;
  }

  async function pendingAsyncTests() {
    while (_pendingAsync.length > 0) {
      const item = _pendingAsync.shift();
      await item;
    }
  }

  function summary() {
    console.log(`\n[${suiteName}] Results: ${passed} passed, ${failed} failed\n`);
  }

  const runner = {
    test,
    asyncTest,
    pendingAsyncTests,
    summary,
  };
  Object.defineProperty(runner, 'passed', { get: () => passed, enumerable: true });
  Object.defineProperty(runner, 'failed', { get: () => failed, enumerable: true });
  return runner;
}

module.exports = { createRunner };
