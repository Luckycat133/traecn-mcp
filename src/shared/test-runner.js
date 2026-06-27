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
 * MUST exit non-zero on failure on its own.
 *
 * `passed` / `failed` are exposed as live getters on the returned
 * runner, so callers can either reference `r.passed` after the fact,
 * or destructure the helpers and read `r.failed` at the end. (Plain
 * primitives would be snapshotted at destructure time.)
 */

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
        // The promise-returning branch. Match the legacy per-file shapes:
        // - Files like `discovery.test.js` don't await — the original
        //   counted these as passed (sync try/catch around fn()), so we
        //   also increment passed immediately to preserve the count.
        // - Files like `command-palette-driver.test.js` queue the async
        //   test for later (Promise.all(_pendingAsync).then(...)); those
        //   callers drain via pendingAsyncTests() before summary().
        // - Files like `dom-driver.test.js` use the for-await drain loop.
        // All three get passed++ here; if the promise rejects later,
        // we increment failed (in addition) so the exit code is correct.
        passed++;
        console.log(`  PASS: ${name}`);
        _pendingAsync.push(
          Promise.resolve(r).catch((err) => {
            failed++;
            console.error(`  FAIL: ${name}: ${err.message}`);
            if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
          })
        );
        return;
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
    const task = (async () => {
      try {
        await fn();
        passed++;
        console.log(`  PASS: ${name}`);
      } catch (err) {
        failed++;
        console.error(`  FAIL: ${name}: ${err.message}`);
        if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
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
