'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  CDPHealthWatcher,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_MAX_RECOVERIES,
  PROBE_METHOD
} = require('./health-watcher');

function makeMockClient() {
  const c = new EventEmitter();
  c.isConnected = true;
  c.closed = false;
  c.sendCalls = [];
  c.sendResponses = [];
  c.nextError = null;
  c.send = async (method, params) => {
    c.sendCalls.push({ method, params });
    if (c.nextError) {
      const err = c.nextError;
      c.nextError = null;
      throw err;
    }
    if (c.sendResponses.length > 0) {
      return c.sendResponses.shift();
    }
    return { ok: true };
  };
  c.close = async () => {
    c.closed = true;
    c.isConnected = false;
  };
  return c;
}

function makeMockGateway(overrides = {}) {
  const events = [];
  const newClient = makeMockClient();
  const gateway = {
    mockBridge: false,
    autoStartTrae: true,
    traeRecoveryCooldownMs: 0,
    lastTraeRecoveryAt: 0,
    recoveryCalls: [],
    newClient,
    _attemptTraeRecovery: async (reason) => {
      gateway.recoveryCalls.push(reason);
      if (gateway.nextRecoveryResult === false) return false;
      if (gateway.nextRecoveryError) {
        const err = gateway.nextRecoveryError;
        gateway.nextRecoveryError = null;
        throw err;
      }
      return true;
    },
    globalMetrics: {
      recordError: (label) => events.push({ kind: 'metric', label })
    },
    ...overrides
  };
  return { gateway, events };
}

// Default recoverFn: simulates the real gateway's _attemptTraeRecovery +
// discoverTarget + connectToTarget sequence by just returning a fresh
// EventEmitter-backed client. The watcher will swap it in and re-attach.
function makeDefaultRecoverFn(gateway) {
  return async function recoverFn() {
    gateway.recoveryCalls.push(new Error('auto-recovery:recoverFn'));
    if (gateway.nextRecoveryResult === false) return false;
    if (gateway.nextRecoveryError) {
      const err = gateway.nextRecoveryError;
      gateway.nextRecoveryError = null;
      throw err;
    }
    return { ok: true, client: gateway.newClient, driver: null };
  };
}

async function flush(times = 1) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

console.log('\n[health-watcher.test.js] Running tests...\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  PASS: ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`        ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    });
}

(async () => {
  await test('disabled watcher ignores disconnect events', async () => {
    const { gateway } = makeMockGateway();
    const w = new CDPHealthWatcher({ gateway, enabled: false });
    const client = makeMockClient();
    w.start(client);
    client.emit('disconnect', { code: 1006 });
    await flush();
    assert.strictEqual(gateway.recoveryCalls.length, 0, 'should not call recovery when disabled');
    assert.strictEqual(client.listenerCount('disconnect'), 0, 'should not even attach listener when disabled');
    w.stop();
  });

  await test('ws-disconnect triggers _attemptTraeRecovery and replaces client', async () => {
    const { gateway, events } = makeMockGateway();
    const recoverFn = makeDefaultRecoverFn(gateway);
    const w = new CDPHealthWatcher({
      gateway, enabled: true, probeIntervalMs: 0, recoverFn, logger: silentLogger()
    });
    const oldClient = makeMockClient();
    w.start(oldClient);
    const replacement = gateway.newClient;
    let replaceSeen = null;
    w.on('health-event', (e) => {
      if (e.type === 'recovery-success') replaceSeen = e;
    });
    oldClient.emit('disconnect', { code: 1006, reason: 'reset' });
    // Wait for the async _attemptAutoRecovery chain.
    for (let i = 0; i < 50; i++) {
      if (gateway.recoveryCalls.length > 0 && w._client === replacement) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(gateway.recoveryCalls.length > 0, 'recovery should be invoked');
    assert.ok(replaceSeen, 'recovery-success event should fire');
    assert.strictEqual(w._client, replacement, 'watcher should hold the new client');
    // Metric event was emitted
    assert.ok(events.some((e) => e.kind === 'metric' && e.label.includes('recovery-success')),
      'metric recorded for recovery-success');
    w.stop();
  });

  await test('probe failure triggers recovery', async () => {
    const { gateway } = makeMockGateway();
    const recoverFn = makeDefaultRecoverFn(gateway);
    const w = new CDPHealthWatcher({
      gateway, enabled: true, probeIntervalMs: 0, recoverFn, logger: silentLogger()
    });
    const client = makeMockClient();
    client.nextError = new Error('probe-fail');
    w.start(client);
    const result = await w.forceProbe();
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.startsWith('probe-'), `expected probe- reason, got ${result.reason}`);
    // Recovery should fire (and succeed via the default mock).
    for (let i = 0; i < 50; i++) {
      if (gateway.recoveryCalls.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(gateway.recoveryCalls.length > 0, 'probe failure should kick recovery');
    w.stop();
  });

  await test('successful probe clears consecutiveFailures', async () => {
    const { gateway } = makeMockGateway();
    const recoverFn = makeDefaultRecoverFn(gateway);
    const w = new CDPHealthWatcher({
      gateway, enabled: true, probeIntervalMs: 0, recoverFn, logger: silentLogger()
    });
    const client = makeMockClient();
    w.start(client);
    // First probe fails (sends error), then recovery swaps client in.
    client.nextError = new Error('first-fail');
    const r1 = await w.forceProbe();
    assert.strictEqual(r1.ok, false);
    // Wait for async recovery to swap client; the new client is the gateway.newClient.
    for (let i = 0; i < 80; i++) {
      if (w.state.consecutiveFailures === 0 && gateway.recoveryCalls.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual(w.state.consecutiveFailures, 0, 'recovery success resets failure count');
    w.stop();
  });

  await test('gateway cooldown suppresses auto-recovery', async () => {
    const { gateway } = makeMockGateway({ traeRecoveryCooldownMs: 60000, lastTraeRecoveryAt: Date.now() });
    const w = new CDPHealthWatcher({ gateway, enabled: true, probeIntervalMs: 0, logger: silentLogger() });
    const client = makeMockClient();
    w.start(client);
    const events = [];
    w.on('health-event', (e) => events.push(e));
    client.emit('disconnect', { code: 1006 });
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(gateway.recoveryCalls.length, 0, 'recovery should be suppressed');
    assert.ok(events.some((e) => e.type === 'cooldown'), 'cooldown event should fire');
    w.stop();
  });

  await test('re-entrant disconnect during recovery is ignored', async () => {
    const { gateway } = makeMockGateway();
    // Make recovery slow so we can fire a second disconnect while it is in flight.
    const slowRecoverFn = async ({ reason }) => {
      gateway.recoveryCalls.push(reason);
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true, client: gateway.newClient };
    };
    const w = new CDPHealthWatcher({
      gateway, enabled: true, probeIntervalMs: 0, recoverFn: slowRecoverFn, logger: silentLogger()
    });
    const client = makeMockClient();
    w.start(client);
    client.emit('disconnect', { code: 1006 });
    await new Promise((r) => setTimeout(r, 5));
    client.emit('disconnect', { code: 1006 });
    for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(gateway.recoveryCalls.length, 1, 're-entrant recovery should be coalesced');
    w.stop();
  });

  await test('consecutive failures past maxRecoveries emits giveup and stops', async () => {
    const { gateway } = makeMockGateway({ nextRecoveryResult: false });
    const recoverFn = makeDefaultRecoverFn(gateway);
    const w = new CDPHealthWatcher({
      gateway, enabled: true, probeIntervalMs: 0, maxRecoveries: 2, recoverFn, logger: silentLogger()
    });
    const client = makeMockClient();
    w.start(client);
    const events = [];
    w.on('health-event', (e) => events.push(e));
    // Fire 3 disconnects; each should advance the failure counter.
    for (let i = 0; i < 3; i++) {
      gateway.lastTraeRecoveryAt = 0;
      client.emit('disconnect', { code: 1006 });
      for (let j = 0; j < 80; j++) await new Promise((r) => setTimeout(r, 5));
    }
    const giveup = events.find((e) => e.type === 'auto-recovery-giveup');
    assert.ok(giveup, 'expected auto-recovery-giveup event');
    assert.ok(w.state.stopped, 'watcher should stop itself after giveup');
    w.stop();
  });

  await test('mockBridge turns the watcher into a no-op', async () => {
    const { gateway } = makeMockGateway({ mockBridge: true });
    const w = new CDPHealthWatcher({ gateway, enabled: true, probeIntervalMs: 0, logger: silentLogger() });
    const client = makeMockClient();
    w.start(client);
    client.emit('disconnect', { code: 1006 });
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(gateway.recoveryCalls.length, 0, 'no recovery when mockBridge is on');
    w.stop();
  });

  await test('autoStartTrae off suppresses auto-recovery', async () => {
    const { gateway } = makeMockGateway({ autoStartTrae: false });
    const w = new CDPHealthWatcher({ gateway, enabled: true, probeIntervalMs: 0, logger: silentLogger() });
    const client = makeMockClient();
    w.start(client);
    client.emit('disconnect', { code: 1006 });
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(gateway.recoveryCalls.length, 0, 'no recovery when autoStartTrae is off');
    w.stop();
  });

  await test('state() reflects runtime config and current counters', async () => {
    const { gateway } = makeMockGateway();
    const w = new CDPHealthWatcher({ gateway, enabled: true, probeIntervalMs: 12345, maxRecoveries: 7, logger: silentLogger() });
    const client = makeMockClient();
    w.start(client);
    const s = w.state;
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.running, true);
    assert.strictEqual(s.probeIntervalMs, 12345);
    assert.strictEqual(s.maxRecoveries, 7);
    assert.strictEqual(s.stopped, false);
    assert.strictEqual(s.consecutiveFailures, 0);
    w.stop();
    const s2 = w.state;
    assert.strictEqual(s2.running, false);
  });

  await test('default config picks up module constants', () => {
    const { gateway } = makeMockGateway();
    const w = new CDPHealthWatcher({ gateway, enabled: true });
    assert.strictEqual(w.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS);
    assert.strictEqual(w.maxRecoveries, DEFAULT_MAX_RECOVERIES);
  });

  await test('start with null client is a no-op', () => {
    const { gateway } = makeMockGateway();
    const w = new CDPHealthWatcher({ gateway, enabled: true, logger: silentLogger() });
    w.start(null);
    assert.strictEqual(w._client, null);
  });

  await test('stop is safe to call multiple times', () => {
    const { gateway } = makeMockGateway();
    const w = new CDPHealthWatcher({ gateway, enabled: true, logger: silentLogger() });
    const client = makeMockClient();
    w.start(client);
    w.stop();
    w.stop();
    assert.strictEqual(w._client, null);
  });

  console.log(`\n[health-watcher.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function silentLogger() {
  // The watcher calls optional log/warn/error methods. Provide no-op
  // implementations so the test output stays clean.
  return { log() {}, warn() {}, error() {} };
}
