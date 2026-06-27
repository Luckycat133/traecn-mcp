'use strict';

// Self-test for createRunner. We bootstrap the runner with its own API
// (3 passing sync tests, 1 failing sync test, 1 async test), then verify
// the summary line reports the right counts.

const assert = require('assert');
const { createRunner } = require('./test-runner');

const r = createRunner('test-runner.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = r;

(async () => {
  test('createRunner returns the expected API surface', () => {
    const probe = createRunner('probe');
    assert.strictEqual(typeof probe.test, 'function');
    assert.strictEqual(typeof probe.asyncTest, 'function');
    assert.strictEqual(typeof probe.pendingAsyncTests, 'function');
    assert.strictEqual(typeof probe.summary, 'function');
    assert.strictEqual(typeof probe.passed, 'number');
    assert.strictEqual(typeof probe.failed, 'number');
  });

  test('test() increments passed on success', () => {
    assert.strictEqual(1 + 1, 2);
  });

  test('test() increments failed on throw', () => {
    // The runner catches the throw; we only assert the post-condition via
    // the summary() line at the end of this file.
    throw new Error('intentional');
  });

  await asyncTest('asyncTest() increments passed on async success', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(typeof Promise, 'function');
  });

  await pendingAsyncTests();

  summary();

  // Self-check: 3 passed, 1 failed (the intentional throw above).
  assert.strictEqual(r.passed, 3, 'expected 3 passing self-tests');
  assert.strictEqual(r.failed, 1, 'expected 1 failing self-test');

  process.exit(0);
})().catch((err) => {
  console.error('[test-runner.test.js] fatal:', err);
  process.exit(1);
});
