'use strict';

const assert = require('assert');
const { Gateway } = require('./gateway');

(async () => {
  const calls = [];
  const ctx = Object.assign(Object.create(Gateway.prototype), {
    driver: {
      switchMode: async mode => { calls.push(['mode', mode]); return { success: true }; },
      checkQueueStatus: async () => ({ running: true, queued: false }),
      switchModel: async model => { calls.push(['model', model]); return { success: true, model }; }
    },
    _ensureRequestedWorkspace: async () => {},
    _normalizeModelSwitchResult: result => result,
    _syncTaskHistoryMirror: () => {},
    _persistActiveQueue: () => {}
  });
  const task = { status: 'queued', desiredMode: 'solo', desiredModel: 'GLM-5.2' };

  const prepared = await Gateway.prototype._prepareQueuedTask.call(ctx, task);

  assert.strictEqual(prepared, false);
  assert.deepStrictEqual(calls, [['mode', 'solo']]);
  assert.strictEqual(task.gatewayPrepared, undefined);

  calls.length = 0;
  const cancelledTask = { status: 'queued', desiredMode: 'solo', desiredModel: 'GLM-5.2' };
  ctx.driver.switchMode = async mode => {
    calls.push(['mode', mode]);
    cancelledTask.cancelRequested = true;
    cancelledTask.status = 'cancelled';
    return { success: true };
  };
  ctx.driver.checkQueueStatus = async () => {
    throw new Error('Cancelled preparation must not continue to the driver');
  };
  assert.strictEqual(await Gateway.prototype._prepareQueuedTask.call(ctx, cancelledTask), false);
  assert.deepStrictEqual(calls, [['mode', 'solo']]);
  assert.strictEqual(cancelledTask.gatewayPrepared, undefined);

  console.log('[gateway-managed-preparation.test.js] PASS');
})().catch(error => {
  console.error('[gateway-managed-preparation.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
