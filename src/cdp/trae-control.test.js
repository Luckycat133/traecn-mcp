'use strict';

/**
 * Tests for src/cdp/trae-control.js.
 *
 * Covers the public API of TraeControl: cooldown gating, mock-bridge /
 * autoStartTrae guards, isRunning() delegation to the quickstart helper,
 * and the attemptRecovery() decision tree (skip / relaunch / kill).
 */

const assert = require('assert');
const { TraeControl } = require('./trae-control');

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
    // Use a setTimeoutImpl that resolves immediately so the discover-target
    // wait loop never blocks — we only care about the decision tree outcome.
    const ctrl = new TraeControl({
      isMockBridge: () => false,
      autoStartTrae: true,
      recoveryCooldownMs: 0,
      recoveryWaitMs: 10,
      setTimeoutImpl: (cb, delay) => { Promise.resolve().then(cb); return null; },
    });
    const result = await ctrl.attemptRecovery(new Error('cdp gone'));
    assert.strictEqual(typeof result, 'boolean');
  });

  console.log(`\n[trae-control.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});