'use strict';

// Deliberate failures run in isolated probes so this suite reports only
// its own assertion outcomes.

const assert = require('assert');
const { spawnSync } = require('child_process');
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
    const probe = createRunner('sync-failure');
    const originalError = console.error;
    const messages = [];
    try {
      console.error = message => messages.push(message);
      probe.test('intentional', () => { throw new Error('intentional'); });
    } finally {
      console.error = originalError;
    }
    assert.strictEqual(probe.passed, 0);
    assert.strictEqual(probe.failed, 1);
    assert.ok(messages.some(message => message.includes('FAIL: intentional')));
  });

  await asyncTest('asyncTest() increments passed on async success', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(typeof Promise, 'function');
  });

  await asyncTest('test() counts promise outcomes only after settlement', async () => {
    const probe = createRunner('async-outcomes');
    let finish;
    const originalLog = console.log;
    const originalError = console.error;
    const messages = [];
    try {
      console.log = message => messages.push(message);
      console.error = message => messages.push(message);
      probe.test('pending success', () => new Promise(resolve => { finish = resolve; }));
      probe.test('rejected body', () => Promise.reject(new Error('expected rejection')));
      assert.strictEqual(probe.passed, 0, 'pending and rejected tests must never report PASS');
      finish();
      await probe.pendingAsyncTests();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.strictEqual(probe.passed, 1);
    assert.strictEqual(probe.failed, 1);
    assert.strictEqual(messages.some(message => message.includes('PASS: rejected body')), false);
  });

  test('unsettled async tests fail natural and explicit process exits', () => {
    for (const explicitExit of [false, true]) {
      const source = [
        `const { createRunner } = require(${JSON.stringify(require.resolve('./test-runner'))});`,
        "const probe = createRunner('unsettled-child');",
        "probe.asyncTest('unsettled body', () => new Promise(() => {}));",
        ...(explicitExit ? ['process.exit(0);'] : [])
      ].join('\n');
      const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 2000 });
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.status, 1, 'unsettled tests must not silently exit successfully');
      assert.match(result.stderr, /unsettled-child.*unsettled body/);
    }
  });

  await pendingAsyncTests();

  summary();

  assert.strictEqual(r.passed, 6, 'expected 6 passing self-tests');
  assert.strictEqual(r.failed, 0, 'expected no failing self-tests');

  process.exit(0);
})().catch((err) => {
  console.error('[test-runner.test.js] fatal:', err);
  process.exit(1);
});
