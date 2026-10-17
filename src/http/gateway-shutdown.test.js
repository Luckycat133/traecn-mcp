'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRunner } = require('../shared/test-runner');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-shutdown-test-'));
const overrides = {
  TRAECN_CONFIG_FILE: path.join(dataRoot, 'config.json'),
  TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH: path.join(dataRoot, 'queue.json'),
  TRAECN_TASK_EVENT_PERSISTENCE_PATH: path.join(dataRoot, 'events.json'),
  TRAECN_TASK_HISTORY_PERSISTENCE_PATH: path.join(dataRoot, 'history.json'),
  TRAECN_AUDIT_LOG_DIR: path.join(dataRoot, 'audit')
};
const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
Object.assign(process.env, overrides);

const { Gateway, startGateway } = require('./gateway');
const { TaskEventStore } = require('../shared/task-event-store');
const { TraeCNAutomationError } = require('../cdp/errors');
const r = createRunner('gateway-shutdown.test.js');

async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not finish within ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected HTTP event waits were not registered or released');
    await new Promise(resolve => setImmediate(resolve));
  }
}

function request(port, route, token = '') {
  let req;
  const result = new Promise(resolve => {
    req = http.get({
      hostname: '127.0.0.1', port, path: route, agent: false,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', error => resolve({ error: error.code }));
    });
    req.on('error', error => resolve({ error: error.code }));
  });
  return { req, result };
}

async function start() {
  const started = await startGateway({ host: '127.0.0.1', port: 0, taskEventStore: new TaskEventStore({ persistencePath: null }) });
  started.gateway._stopBackgroundPolling();
  return started;
}

async function cleanup(started) {
  started.server.closeAllConnections();
  await within(started.close(), 8000);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function connectionFixture(hooks = {}) {
  const calls = { discovers: 0, connects: 0, detects: 0, drivers: 0, mocks: 0, recoveries: 0, closes: [], healthStarts: [], healthStops: 0 };
  const environment = { fixture: 'environment' };
  const adapter = { fixture: 'adapter' };
  const makeClient = id => {
    const client = {
      id, isConnected: true,
      async close() { calls.closes.push(client); client.isConnected = false; }
    };
    return client;
  };
  const acquired = makeClient('fresh-owned-client');
  const task = {
    taskId: 'owned-submitted-task', task: 'Complete the isolated task',
    status: 'executing', submittedToTrae: true, submittedAt: 1790991967893,
    soloChat: { nativeSessionId: 'owned-native-session' }
  };
  const gateway = {
    mockBridge: false, client: null, driver: null, traeEnvironment: null, traeAdapter: null,
    taskQueue: new Map([[task.taskId, task]]),
    healthWatcher: {
      start(client) { calls.healthStarts.push(client); },
      stop() { calls.healthStops++; }
    },
    traeControl: { activateWindow() { throw new Error('connection fixture must not activate an application'); } },
    async detectTraeEnvironment(options) {
      calls.detects++;
      assert.strictEqual(options.client, acquired);
      return hooks.detect ? hooks.detect(options) : environment;
    },
    selectTraeAdapter: () => adapter,
    async _attemptTraeRecovery(error) {
      calls.recoveries++;
      return hooks.recover ? hooks.recover(error) : false;
    }
  };
  // Evaluate the actual production method with scoped offline dependencies.
  // Discovery/connection never reaches a WebSocket or native application.
  gateway._ensureConnection = vm.runInNewContext(`({${Gateway.prototype._ensureConnection.toString()}})._ensureConnection`, {
    async discoverTarget() {
      calls.discovers++;
      return hooks.discover ? hooks.discover() : { id: 'owned-page', cdpVersion: {} };
    },
    async connectToTarget() {
      calls.connects++;
      return hooks.connect ? hooks.connect() : acquired;
    },
    DomDriver: class {
      constructor(client) {
        calls.drivers++;
        this.client = client;
        if (hooks.driver) hooks.driver(client);
      }
      async inspectSetupWizard() { return { isSetup: false }; }
    },
    MockDriver: class { constructor() { calls.mocks++; } },
    getConfig: () => ({}), mergeAdapterConfig: () => ({}), TraeCNAutomationError,
    process: { platform: 'darwin' }, console: { error() {}, warn() {} }
  });
  const taskSnapshot = JSON.stringify([...gateway.taskQueue]);
  return {
    gateway, calls, acquired, environment, adapter, makeClient,
    assertTaskUnchanged() { assert.strictEqual(JSON.stringify([...gateway.taskQueue]), taskSnapshot); }
  };
}

function shutdownError(error) {
  return error.code === 'CDP_DISCONNECTED' && /shut(?:ting)?\s*down/i.test(error.message);
}

function beginShutdown(gateway) { gateway._shutdownInProgress = Promise.resolve(); }

(async () => {
  await r.asyncTest('Gateway connection shutdown rejects an already-closed native connection entry', async () => {
    const f = connectionFixture();
    beginShutdown(f.gateway);
    await assert.rejects(f.gateway._ensureConnection(), shutdownError);
    assert.strictEqual(f.calls.discovers, 0);
    assert.strictEqual(f.calls.connects, 0);
    assert.strictEqual(f.calls.drivers, 0);
    assert.strictEqual(f.calls.recoveries, 0);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown cannot create a MockDriver after close begins', async () => {
    const f = connectionFixture();
    f.gateway.mockBridge = true;
    beginShutdown(f.gateway);
    await assert.rejects(f.gateway._ensureConnection(), shutdownError);
    assert.strictEqual(f.gateway.driver, null);
    assert.strictEqual(f.calls.mocks, 0);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown does not discover after a stale close resolves late', async () => {
    const gate = deferred();
    const f = connectionFixture();
    const stale = f.makeClient('stale');
    stale.isConnected = false;
    stale.close = async () => { f.calls.closes.push(stale); await gate.promise; };
    f.gateway.client = stale;
    f.gateway.driver = { stale: true };
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.closes.length === 1);
    beginShutdown(f.gateway);
    gate.resolve();
    await rejection;
    assert.strictEqual(f.calls.discovers, 0);
    assert.strictEqual(f.calls.recoveries, 0);
    assert.strictEqual(f.gateway.client, null);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown stops after delayed discovery without connecting', async () => {
    const gate = deferred();
    const f = connectionFixture({ discover: () => gate.promise });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.discovers === 1);
    beginShutdown(f.gateway);
    gate.resolve({ id: 'late-page' });
    await rejection;
    assert.strictEqual(f.calls.connects, 0);
    assert.strictEqual(f.calls.detects, 0);
    assert.strictEqual(f.calls.healthStarts.length, 0);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown does not recover a discovery failure after close begins', async () => {
    const gate = deferred();
    const f = connectionFixture({ discover: () => gate.promise });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.discovers === 1);
    beginShutdown(f.gateway);
    gate.reject(new Error('own discovery was interrupted'));
    await rejection;
    assert.strictEqual(f.calls.recoveries, 0);
    assert.strictEqual(f.calls.connects, 0);
  });

  await r.asyncTest('Gateway connection shutdown closes a late target client without publishing or attaching it', async () => {
    const gate = deferred();
    const f = connectionFixture({ connect: () => gate.promise });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.connects === 1);
    beginShutdown(f.gateway);
    gate.resolve(f.acquired);
    await rejection;
    assert.deepStrictEqual(f.calls.closes, [f.acquired]);
    assert.strictEqual(f.gateway.client, null);
    assert.strictEqual(f.gateway.driver, null);
    assert.strictEqual(f.calls.detects, 0);
    assert.strictEqual(f.calls.drivers, 0);
    assert.strictEqual(f.calls.healthStarts.length, 0);
    assert.strictEqual(f.calls.recoveries, 0);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown does not recover a target connection failure after close begins', async () => {
    const gate = deferred();
    const f = connectionFixture({ connect: () => gate.promise });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.connects === 1);
    beginShutdown(f.gateway);
    gate.reject(new Error('own target connection was interrupted'));
    await rejection;
    assert.strictEqual(f.calls.recoveries, 0);
    assert.strictEqual(f.calls.drivers, 0);
    assert.strictEqual(f.calls.healthStarts.length, 0);
  });

  await r.asyncTest('Gateway connection shutdown closes a late acquired client while retaining another current connection', async () => {
    const gate = deferred();
    const f = connectionFixture({ connect: () => gate.promise });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.connects === 1);
    const newer = f.makeClient('newer-current');
    const newerDriver = { newer: true };
    const newerEnvironment = { newer: true };
    const newerAdapter = { newer: true };
    Object.assign(f.gateway, { client: newer, driver: newerDriver, traeEnvironment: newerEnvironment, traeAdapter: newerAdapter });
    beginShutdown(f.gateway);
    gate.resolve(f.acquired);
    await rejection;
    assert.deepStrictEqual(f.calls.closes, [f.acquired]);
    assert.strictEqual(f.gateway.client, newer);
    assert.strictEqual(f.gateway.driver, newerDriver);
    assert.strictEqual(f.gateway.traeEnvironment, newerEnvironment);
    assert.strictEqual(f.gateway.traeAdapter, newerAdapter);
    assert.strictEqual(f.calls.drivers, 0);
    assert.strictEqual(f.calls.healthStarts.length, 0);
    assert.strictEqual(f.calls.healthStops, 0);
    assert.strictEqual(f.calls.recoveries, 0);
  });

  await r.asyncTest('Gateway connection shutdown closes an owned client delayed during driver environment detection', async () => {
    const gate = deferred();
    const f = connectionFixture({ detect: () => gate.promise });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.detects === 1);
    beginShutdown(f.gateway);
    gate.resolve(f.environment);
    await rejection;
    assert.deepStrictEqual(f.calls.closes, [f.acquired]);
    assert.strictEqual(f.gateway.client, null);
    assert.strictEqual(f.gateway.driver, null);
    assert.strictEqual(f.gateway.traeEnvironment, null);
    assert.strictEqual(f.gateway.traeAdapter, null);
    assert.strictEqual(f.calls.drivers, 0);
    assert.strictEqual(f.calls.healthStarts.length, 0);
    assert.strictEqual(f.calls.recoveries, 0);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown does not recover a late environment detection error', async () => {
    const gate = deferred();
    const f = connectionFixture({ detect: () => gate.promise });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.detects === 1);
    beginShutdown(f.gateway);
    gate.reject(new Error('own environment probe was interrupted'));
    await rejection;
    assert.deepStrictEqual(f.calls.closes, [f.acquired]);
    assert.strictEqual(f.calls.recoveries, 0);
    assert.strictEqual(f.calls.healthStarts.length, 0);
  });

  await r.asyncTest('Gateway connection shutdown cannot publish or start health after the driver preparation await', async () => {
    const f = connectionFixture({ driver: () => queueMicrotask(() => beginShutdown(f.gateway)) });
    await assert.rejects(f.gateway._ensureConnection(), shutdownError);
    assert.strictEqual(f.calls.drivers, 1, 'the local driver was prepared before shutdown began');
    assert.deepStrictEqual(f.calls.closes, [f.acquired]);
    assert.strictEqual(f.gateway.client, null);
    assert.strictEqual(f.gateway.driver, null);
    assert.strictEqual(f.gateway.traeEnvironment, null);
    assert.strictEqual(f.gateway.traeAdapter, null);
    assert.strictEqual(f.calls.healthStarts.length, 0);
    assert.strictEqual(f.calls.recoveries, 0);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown does not rediscover after an earlier recovery completes late', async () => {
    const gate = deferred();
    const f = connectionFixture({
      discover: async () => { throw new Error('initial owned discovery failed'); },
      recover: () => gate.promise
    });
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => f.calls.recoveries === 1);
    beginShutdown(f.gateway);
    gate.resolve(true);
    await rejection;
    assert.strictEqual(f.calls.discovers, 1);
    assert.strictEqual(f.calls.connects, 0);
    assert.strictEqual(f.calls.recoveries, 1);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown guards all awaits on the post-recovery attempt', async () => {
    for (const stage of ['discover', 'connect', 'detect']) {
      const gate = deferred();
      const f = connectionFixture({
        discover: async () => {
          if (f.calls.discovers === 1) throw new Error('first discovery failed');
          return stage === 'discover' ? gate.promise : { id: 'recovered-page' };
        },
        connect: () => stage === 'connect' ? gate.promise : f.acquired,
        detect: () => stage === 'detect' ? gate.promise : f.environment,
        recover: async () => true
      });
      const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
      await until(() => stage === 'discover' ? f.calls.discovers === 2
        : stage === 'connect' ? f.calls.connects === 1 : f.calls.detects === 1);
      beginShutdown(f.gateway);
      gate.resolve(stage === 'discover' ? { id: 'late-recovered-page' }
        : stage === 'connect' ? f.acquired : f.environment);
      await rejection;
      assert.strictEqual(f.gateway.client, null, stage);
      assert.strictEqual(f.gateway.driver, null, stage);
      assert.strictEqual(f.calls.drivers, 0, stage);
      assert.strictEqual(f.calls.healthStarts.length, 0, stage);
      assert.strictEqual(f.calls.recoveries, 1, stage);
      assert.deepStrictEqual(f.calls.closes, stage === 'discover' ? [] : [f.acquired], stage);
      f.assertTaskUnchanged();
    }
  });

  await r.asyncTest('Gateway connection shutdown stale cleanup retains a newer connection and driver', async () => {
    const gate = deferred();
    const f = connectionFixture();
    const stale = f.makeClient('stale');
    const newer = f.makeClient('newer');
    stale.isConnected = false;
    stale.close = async () => { f.calls.closes.push(stale); await gate.promise; };
    f.gateway.client = stale;
    f.gateway.driver = { stale: true };
    const pending = f.gateway._ensureConnection();
    await until(() => f.calls.closes.length === 1);
    const newerDriver = { inspectSetupWizard: async () => ({ isSetup: false }) };
    const newerEnvironment = { newer: true };
    const newerAdapter = { newer: true };
    Object.assign(f.gateway, { client: newer, driver: newerDriver, traeEnvironment: newerEnvironment, traeAdapter: newerAdapter });
    gate.resolve();
    await pending;
    assert.strictEqual(f.gateway.client, newer);
    assert.strictEqual(f.gateway.driver, newerDriver);
    assert.strictEqual(f.gateway.traeEnvironment, newerEnvironment);
    assert.strictEqual(f.gateway.traeAdapter, newerAdapter);
    assert.deepStrictEqual(f.calls.closes, [stale]);
    assert.strictEqual(f.calls.discovers, 0);
    assert.strictEqual(f.calls.drivers, 0);
    assert.strictEqual(f.calls.healthStarts.length, 0);
    assert.strictEqual(f.calls.healthStops, 0);
  });

  await r.asyncTest('Gateway connection shutdown does not auto-advance a setup probe completed after close', async () => {
    const gate = deferred();
    const f = connectionFixture();
    let advances = 0;
    f.gateway.client = f.acquired;
    f.gateway.driver = {
      inspectSetupWizard: () => gate.promise,
      async completeSetupIfPresent() { advances++; return { completed: false, steps: 0 }; }
    };
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    beginShutdown(f.gateway);
    gate.resolve({ isSetup: true });
    await rejection;
    assert.strictEqual(advances, 0);
    assert.strictEqual(f.calls.discovers, 0);
  });

  await r.asyncTest('Gateway connection shutdown does not reconnect after a delayed setup advance', async () => {
    const gate = deferred();
    const f = connectionFixture();
    let advances = 0;
    f.gateway.client = f.acquired;
    f.gateway.driver = {
      inspectSetupWizard: async () => ({ isSetup: true }),
      completeSetupIfPresent() { advances++; return gate.promise; }
    };
    const rejection = assert.rejects(f.gateway._ensureConnection(), shutdownError);
    await until(() => advances === 1);
    beginShutdown(f.gateway);
    f.acquired.isConnected = false;
    gate.resolve({ completed: true, steps: 1 });
    await rejection;
    assert.strictEqual(f.calls.discovers, 0);
    assert.strictEqual(f.calls.recoveries, 0);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown guards retain ordinary fresh connection behavior', async () => {
    const f = connectionFixture();
    await f.gateway._ensureConnection();
    assert.strictEqual(f.gateway.client, f.acquired);
    assert.strictEqual(f.gateway.driver.client, f.acquired);
    assert.strictEqual(f.gateway.traeEnvironment, f.environment);
    assert.strictEqual(f.gateway.traeAdapter, f.adapter);
    assert.strictEqual(f.calls.discovers, 1);
    assert.strictEqual(f.calls.connects, 1);
    assert.strictEqual(f.calls.drivers, 1);
    assert.deepStrictEqual(f.calls.healthStarts, [f.acquired]);
    assert.strictEqual(f.calls.recoveries, 0);
    assert.deepStrictEqual(f.calls.closes, []);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway connection shutdown guards retain one active recovery attempt', async () => {
    const f = connectionFixture({
      discover: async () => {
        if (f.calls.discovers === 1) throw new Error('temporary owned discovery failure');
        return { id: 'recovered-page' };
      },
      recover: async () => true
    });
    await f.gateway._ensureConnection();
    assert.strictEqual(f.calls.discovers, 2);
    assert.strictEqual(f.calls.connects, 1);
    assert.strictEqual(f.calls.recoveries, 1);
    assert.strictEqual(f.calls.drivers, 1);
    assert.deepStrictEqual(f.calls.healthStarts, [f.acquired]);
    f.assertTaskUnchanged();
  });

  await r.asyncTest('Gateway closes a silent TCP preconnection without waiting for its client', async () => {
    const started = await start();
    const socket = net.connect({ host: '127.0.0.1', port: started.server.address().port });
    try {
      await within(new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      }), 5000);
      const disconnected = new Promise(resolve => socket.once('close', resolve));
      await within(started.close(), 8000);
      await within(disconnected, 1000);
      assert.strictEqual(socket.destroyed, true);
      assert.strictEqual(started.gateway.server, null);
    } finally {
      socket.destroy();
      await cleanup(started);
    }
  });

  await r.asyncTest('Gateway drains a normal in-flight HTTP response before closing', async () => {
    const gateway = new Gateway();
    let requestStarted;
    const ready = new Promise(resolve => { requestStarted = resolve; });
    const server = http.createServer((req, res) => {
      requestStarted();
      setTimeout(() => res.end('DRAIN_COMPLETE'), 100);
    });
    gateway.server = server;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = request(server.address().port, '/drain');
    try {
      await within(ready, 5000);
      const closing = gateway.gracefulShutdown();
      assert.deepStrictEqual(await within(client.result, 5000), { status: 200, body: 'DRAIN_COMPLETE' });
      await within(closing, 5000);
    } finally {
      client.req.destroy();
      server.closeAllConnections();
      await gateway.gracefulShutdown();
    }
  });

  await r.asyncTest('Gateway releases a disconnected long poll and delivers one event to 31 remaining HTTP clients', async () => {
    const started = await start();
    const store = started.gateway.taskEventStore;
    const clients = Array.from({ length: 32 }, (_, index) => request(
      started.server.address().port, `/api/task-events?clientId=http-client-${index}&waitMs=30000`, started.gateway.token
    ));
    try {
      await until(() => store._waiters.size === 32);
      assert.strictEqual(store.emitter.listenerCount('append'), 1);
      clients[0].req.destroy();
      await until(() => store._waiters.size === 31);
      const event = store.append({ type: 'task.completed', taskId: 'http-fanout-result', status: 'done' });
      const results = await within(Promise.all(clients.map(client => client.result)), 5000);
      assert.ok(results[0].error);
      for (const result of results.slice(1)) {
        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(JSON.parse(result.body).events, [event]);
      }
      assert.strictEqual(store._waiters.size, 0);
      assert.strictEqual(store.emitter.listenerCount('append'), 0);
    } finally {
      for (const client of clients) client.req.destroy();
      await cleanup(started);
    }
  });

  await r.asyncTest('Gateway shutdown bounds unfinished event responses and releases their waiters', async () => {
    const started = await start();
    const store = started.gateway.taskEventStore;
    const clients = Array.from({ length: 4 }, (_, index) => request(
      started.server.address().port, `/api/task-events?clientId=shutdown-client-${index}&waitMs=30000`, started.gateway.token
    ));
    try {
      await until(() => store._waiters.size === 4);
      await within(started.close(), 8000);
      const results = await within(Promise.all(clients.map(client => client.result)), 1000);
      assert.ok(results.every(result => result.error));
      await until(() => store._waiters.size === 0);
      assert.strictEqual(store.emitter.listenerCount('append'), 0);
    } finally {
      for (const client of clients) client.req.destroy();
      await cleanup(started);
    }
  });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  r.summary();
  if (r.failed) process.exitCode = 1;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
