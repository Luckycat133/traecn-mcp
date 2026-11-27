'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { CheckInDriver } = require('./check-in-driver');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('check-in-driver.test.js');
const { asyncTest, pendingAsyncTests, summary } = runner;
const STATUS = 'vscode:sandbox::main-invoke-fetchCheckinCreditsStatus';
const CLAIM = 'vscode:sandbox::main-invoke-claimCheckinCredits';
const DAY = '2026-11-06';
const NOW = Date.parse('2026-11-05T16:05:00Z');
const ready = { status: 200, data: { enable: true, checked_in: false, credits: 10 } };
const checked = { status: 200, data: { enable: true, checked_in: true, credits: 10 } };

function fixture(replies, { hasIpc = true, loginVisible = false, now = () => NOW } = {}) {
  const calls = [];
  const wire = [];
  const ipcRenderer = {
    async invoke(...args) {
      calls.push(args);
      assert.ok(replies.length, `Unexpected native call: ${args[0]}`);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    }
  };
  const client = {
    async send(method, options) {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(options.awaitPromise, true);
      assert.equal(options.returnByValue, true);
      const value = await vm.runInNewContext(options.expression, {
        window: {
          ...(hasIpc && { vscode: { ipcRenderer } }),
          document: {
            querySelector: () => loginVisible ? { shadowRoot: { querySelector: () => ({}) } } : null
          }
        }
      });
      const serialized = JSON.stringify(value);
      wire.push(serialized);
      return { result: { value: JSON.parse(serialized) } };
    }
  };
  return { driver: new CheckInDriver(client, { now }), calls, wire };
}

asyncTest('reads only sanitized native status and Beijing business date', async () => {
  const { driver, calls, wire } = fixture([
    { ...ready, data: { ...ready.data, user_id: 'not exported', token: 'not exported', extra_credits: Infinity } }
  ]);
  assert.deepEqual(await driver.status(), { state: 'ready', day: DAY, checkedIn: false, credits: 10 });
  assert.deepEqual(calls, [[STATUS]]);
  assert.doesNotMatch(wire[0], /not exported/);
});

asyncTest('coalesces concurrent claims and requires a fresh read to confirm success', async () => {
  const { driver, calls } = fixture([ready, { status: 200, beijingDayKey: DAY, data: { code: 0 } }, checked]);
  const results = await Promise.all([driver.claim(), driver.claim()]);
  const claimed = { state: 'claimed', day: DAY, checkedIn: true, credits: 10, attempted: true };
  assert.deepEqual(results, [claimed, claimed]);
  // No source argument: the native app attaches a lottery draw for UI sources.
  assert.deepEqual(calls, [[STATUS], [CLAIM], [STATUS]]);
});

asyncTest('skips the write when account or device has checked in, or the feature is disabled', async () => {
  const fixtures = [
    [checked, 'already_claimed', undefined],
    [{ ...ready, data: { ...ready.data, did_checked_in: true } }, 'unavailable', 'device_already_checked_in'],
    [{ ...ready, data: { ...ready.data, enable: false } }, 'unavailable', 'checkin_disabled']
  ];
  for (const [reply, state, reason] of fixtures) {
    const { driver, calls } = fixture([reply]);
    const result = await driver.claim();
    assert.equal(result.state, state);
    assert.equal(result.reason, reason);
    assert.equal(result.attempted, undefined);
    assert.deepEqual(calls, [[STATUS]]);
  }
});

asyncTest('distinguishes unavailable, login required, and malformed status before writing', async () => {
  const noIpc = fixture([], { hasIpc: false });
  assert.equal((await noIpc.driver.claim()).reason, 'ipc_unavailable');
  const login = fixture([new Error('Checkin credits is unavailable')], { loginVisible: true });
  assert.equal((await login.driver.claim()).state, 'login_required');
  assert.deepEqual(login.calls, [[STATUS]]);
  const native401 = fixture([{ status: 401 }]);
  assert.equal((await native401.driver.claim()).state, 'login_required');
  const invalid = fixture([{ status: 200, data: { enable: true } }]);
  assert.equal((await invalid.driver.claim()).state, 'unknown');
  assert.deepEqual(invalid.calls, [[STATUS]]);
});

asyncTest('after a claim transport error reads once and does not repeat the write', async () => {
  const { driver, calls, wire } = fixture([ready, new Error('wire failure with a private value'), ready]);
  assert.deepEqual(await driver.claim(), {
    state: 'unknown', day: DAY, checkedIn: null, attempted: true, reason: 'claim_unverified'
  });
  assert.deepEqual(calls, [[STATUS], [CLAIM], [STATUS]]);
  assert.doesNotMatch(wire[1], /private value/);
});

asyncTest('reports verified account state without attributing a lost claim response', async () => {
  const { driver } = fixture([ready, new Error('connection interrupted'), checked]);
  assert.deepEqual(await driver.claim(), {
    state: 'already_claimed', day: DAY, checkedIn: true, credits: 10, attempted: true
  });
});

asyncTest('rejects a native success for a different Beijing business day', async () => {
  const { driver, calls } = fixture([ready, { status: 200, beijingDayKey: '2026-11-07' }, checked]);
  assert.equal((await driver.claim()).reason, 'business_day_changed');
  assert.deepEqual(calls, [[STATUS], [CLAIM], [STATUS]]);
});

pendingAsyncTests().then(() => {
  summary();
  if (runner.failed > 0) process.exitCode = 1;
});
