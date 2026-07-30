'use strict';

const assert = require('assert');
const { Gateway } = require('./gateway');

(async () => {
  const calls = [];
  const ctx = {
    driver: {
      switchMode: async mode => { calls.push(['mode', mode]); return { success: true }; },
      checkQueueStatus: async () => ({ running: true, queued: false }),
      switchModel: async model => { calls.push(['model', model]); return { success: true, model }; }
    },
    _ensureRequestedWorkspace: async () => {},
    _normalizeModelSwitchResult: result => result,
    _syncTaskHistoryMirror: () => {},
    _persistActiveQueue: () => {}
  };
  const task = { desiredMode: 'solo', desiredModel: 'GLM-5.2' };

  const prepared = await Gateway.prototype._prepareQueuedTask.call(ctx, task);

  assert.strictEqual(prepared, false);
  assert.deepStrictEqual(calls, [['mode', 'solo']]);
  assert.strictEqual(task.gatewayPrepared, undefined);

  console.log('[gateway-managed-preparation.test.js] PASS');
})().catch(error => {
  console.error('[gateway-managed-preparation.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
