'use strict';

/**
 * Tests for src/cdp/trae-control.js.
 *
 * Covers the public API of TraeControl: cooldown gating, mock-bridge /
 * autoStartTrae guards, isRunning() delegation to the quickstart helper,
 * and recovery when the TraeCN binary is unavailable.
 */

const assert = require('assert');
const quickstart = require('../config/quickstart');

// TraeControl captures binary discovery at import time. Simulate an
// uninstalled app even on a host that has a real TraeCN installation.
const findTraeCNBinary = quickstart.findTraeCNBinary;
let TraeControl;
try {
  quickstart.findTraeCNBinary = () => null;
  ({ TraeControl } = require('./trae-control'));
} finally {
  quickstart.findTraeCNBinary = findTraeCNBinary;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log('\n[trae-control.test.js] Running TraeControl tests...\n');

test('TraeControl: canRecover respects cooldown', () => {
  const ctrl = new TraeControl({ recoveryCooldownMs: 60000 });
  assert.strictEqual(ctrl.canRecover(), true);
  ctrl.lastRecoveryAt = Date.now();
  assert.strictEqual(ctrl.canRecover(), false);
});

test('TraeControl: isRunning delegates without throwing', () => {
  const ctrl = new TraeControl();
  const result = ctrl.isRunning();
  assert.strictEqual(typeof result, 'boolean');
});

async function main() {
  await asyncTest('TraeControl: activation reuses a running application even when auto-start is disabled', async () => {
    let invocation;
    const ctrl = new TraeControl({ autoStartTrae: false, activateWindowImpl: async options => {
      invocation = options;
      return { ok: true };
    } });
    ctrl.isRunning = () => true;
    assert.strictEqual(await ctrl.activateWindow({ binPath: '/Applications/Trae CN.app' }), true);
    assert.deepStrictEqual(invocation, { binPath: '/Applications/Trae CN.app' });
    assert.strictEqual(ctrl.lastRecoveryAt, 0);
  });

  await asyncTest('TraeControl: activation never launches a stopped application or the mock bridge', async () => {
    let activations = 0;
    for (const mock of [false, true]) {
      const ctrl = new TraeControl({ isMockBridge: () => mock, activateWindowImpl: async () => {
        activations++;
        return { ok: true };
      } });
      ctrl.isRunning = () => mock;
      assert.strictEqual(await ctrl.activateWindow({ binPath: '/Applications/Trae CN.app' }), false);
    }
    assert.strictEqual(activations, 0);
  });

  await asyncTest('TraeControl: attemptRecovery returns false when mock bridge is on', async () => {
    const ctrl = new TraeControl({
      isMockBridge: () => true,
      autoStartTrae: true,
    });
    const result = await ctrl.attemptRecovery(new Error('cdp gone'));
    assert.strictEqual(result, false);
  });

  await asyncTest('TraeControl: attemptRecovery returns false when autoStartTrae is off', async () => {
    const ctrl = new TraeControl({
      isMockBridge: () => false,
      autoStartTrae: false,
    });
    const result = await ctrl.attemptRecovery(new Error('cdp gone'));
    assert.strictEqual(result, false);
  });

  await asyncTest('TraeControl: attemptRecovery returns false when cooldown is active', async () => {
    const ctrl = new TraeControl({
      isMockBridge: () => false,
      autoStartTrae: true,
      recoveryCooldownMs: 60000,
    });
    ctrl.lastRecoveryAt = Date.now();
    const result = await ctrl.attemptRecovery(new Error('cdp gone'));
    assert.strictEqual(result, false);
  });

  await asyncTest('TraeControl: attemptRecovery exits early when no binary is found', async () => {
    const warnings = [];
    const ctrl = new TraeControl({
      isMockBridge: () => false,
      autoStartTrae: true,
      recoveryCooldownMs: 0,
      logger: { warn: message => warnings.push(message) },
    });
    const result = await ctrl.attemptRecovery(new Error('cdp gone'));
    assert.strictEqual(result, false);
    assert.deepStrictEqual(warnings, ['[TraeControl] recovery skipped: binary not found']);
  });

  console.log(`\n[trae-control.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
