'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRunner } = require('../../shared/test-runner');
const app = require('./app');
const stateApi = require('./state');

const runner = createRunner('web-console/app.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[web-console/app.test.js] Running console application tests...\n');

function storageDouble(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function response(status, payload, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries({ 'content-type': 'application/json', ...headers }).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null;
      },
    },
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controllerDouble(fetch) {
  const timers = new Map();
  let nextTimer = 0;
  const root = {
    document: { hidden: false },
    location: { origin: 'http://127.0.0.1:3000' },
    sessionStorage: storageDouble(),
    localStorage: storageDouble(),
    fetch,
    TextEncoder,
    btoa,
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const controller = new app.ConsoleController({ root });
  controller.render = () => {};
  controller.announce = () => {};
  controller.refs = {
    'gateway-token': { value: '' },
    'connection-dialog': {
      open: false,
      close() {
        this.open = false;
      },
    },
  };
  controller.state.connection.auth = 'ready';
  return { controller, root, timers };
}

function installSocketDouble(root) {
  const sockets = [];
  root.WebSocket = class Socket {
    constructor() {
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    close() {
      this.readyState = 3;
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    emit(type, data) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      return this.listeners.get(type)?.(data);
    }
  };
  return sockets;
}

function composerDouble(fetch) {
  const fixture = controllerDouble(fetch);
  const { controller, root } = fixture;
  let requestId = 0;
  root.crypto = { randomUUID: () => `request-${++requestId}` };
  controller.catalog.workspace = { verified: true };
  controller.refs['task-message'] = { value: '完成原有任务' };
  controller.refs['review-required'] = { checked: false };
  controller.refs['submit-task'] = { disabled: false };
  controller.fetchTask = async () => null;
  return fixture;
}

test('token store uses session storage and removes the legacy local token', () => {
  const session = storageDouble();
  const legacy = storageDouble({ [app.LEGACY_TOKEN_KEY]: 'legacy-secret' });
  const store = app.createTokenStore(session, legacy);

  store.removeLegacy();
  assert.strictEqual(legacy.values.has(app.LEGACY_TOKEN_KEY), false);
  store.save('current-tab-token');
  assert.strictEqual(store.load(), 'current-tab-token');
  assert.strictEqual(session.values.get(app.SESSION_TOKEN_KEY), 'current-tab-token');
  store.clear();
  assert.strictEqual(store.load(), '');
});

test('browser bearer protocol encodes Unicode without exposing the raw token', () => {
  const token = '私有-token-✓';
  const protocols = app.websocketProtocols(token, { Buffer });
  assert.deepStrictEqual(protocols.slice(0, 1), [app.WS_PUBLIC_PROTOCOL]);
  assert.strictEqual(protocols.length, 2);
  assert.match(protocols[1], /^traecnclaw\.bearer\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(protocols[1], /私有|token|✓/);
  assert.strictEqual(
    protocols[1].slice(app.WS_BEARER_PROTOCOL_PREFIX.length),
    Buffer.from(token, 'utf8').toString('base64url')
  );
});

test('WebSocket URL stays same-origin and contains no credential query', () => {
  assert.strictEqual(
    app.buildWebSocketUrl({ origin: 'http://127.0.0.1:3000' }),
    'ws://127.0.0.1:3000/ws/events'
  );
  assert.strictEqual(
    app.buildWebSocketUrl({ origin: 'https://console.example.test' }),
    'wss://console.example.test/ws/events'
  );
  assert.doesNotMatch(app.buildWebSocketUrl({ origin: 'https://host.test' }), /token|auth|\?/i);
});

test('reconnect backoff is bounded at the documented schedule', () => {
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4, 5, 99].map(app.reconnectDelay),
    [1000, 2000, 5000, 10000, 15000, 15000, 15000]
  );
});

test('idempotency keys are stable-prefix opaque request identities', () => {
  assert.strictEqual(
    app.createIdempotencyKey({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }),
    'console-00000000-0000-4000-8000-000000000001'
  );
  assert.strictEqual(
    app.createIdempotencyKey({ now: () => 42, random: () => 0.25 }),
    `console-${(42).toString(36)}-${(0.25).toString(36).slice(2)}`
  );
});

test('only terminal history entries become recent-result projections', () => {
  assert.deepStrictEqual(
    app
      .terminalHistoryTasks([
        { taskId: 'done-1', status: 'completed' },
        { taskId: 'failed-1', status: 'failed' },
        { taskId: 'queued-1', status: 'pending' },
        { taskId: 'approval-1', status: 'approval_required' },
      ])
      .map((item) => item.taskId),
    ['done-1', 'failed-1']
  );
});

asyncTest(
  'API client sends credentials only in Authorization and uses hardened fetch options',
  async () => {
    const calls = [];
    const client = app.createApiClient({
      origin: 'https://console.example.test',
      token: 'gateway-secret',
      fetch: async (url, options) => {
        calls.push({ url, options });
        return response(202, { taskId: 'task-1', status: 'accepted' });
      },
    });

    await client.request('/api/tasks/submit', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'console-request-1' },
      body: { message: 'Do the work' },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://console.example.test/api/tasks/submit');
    assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer gateway-secret');
    assert.strictEqual(calls[0].options.headers['Idempotency-Key'], 'console-request-1');
    assert.strictEqual(calls[0].options.credentials, 'omit');
    assert.strictEqual(calls[0].options.cache, 'no-store');
    assert.strictEqual(calls[0].options.redirect, 'error');
    assert.deepStrictEqual(JSON.parse(calls[0].options.body), { message: 'Do the work' });
    assert.doesNotMatch(calls[0].url, /gateway-secret/);
  }
);

asyncTest('API client clears Authorization when its in-memory token is cleared', async () => {
  const calls = [];
  const client = app.createApiClient({
    origin: 'http://127.0.0.1:3000',
    token: 'temporary',
    fetch: async (_url, options) => {
      calls.push(options);
      return response(200, { tasks: [] });
    },
  });
  await client.request('/api/queue/status');
  client.setToken('');
  await client.request('/api/queue/status');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer temporary');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(calls[1].headers, 'Authorization'),
    false
  );
});

asyncTest('API client rejects cross-origin-shaped paths before fetch', async () => {
  let called = false;
  const client = app.createApiClient({
    origin: 'https://console.example.test',
    fetch: async () => {
      called = true;
      return response(200, {});
    },
  });
  await assert.rejects(() => client.request('//evil.example/api'), /same-origin/);
  assert.strictEqual(called, false);
});

asyncTest('API errors retain machine status while exposing bounded user copy', async () => {
  const client = app.createApiClient({
    origin: 'https://console.example.test',
    fetch: async () =>
      response(429, { error: 'rate_limited', message: 'Try later' }, { 'retry-after': '5s' }),
  });
  await assert.rejects(
    () => client.request('/api/status'),
    (error) => {
      assert.ok(error instanceof app.ApiError);
      assert.strictEqual(error.status, 429);
      assert.strictEqual(error.code, 'rate_limited');
      assert.strictEqual(error.retryAfter, '5s');
      assert.match(app.safeErrorMessage(error), /5s/);
      return true;
    }
  );
});

asyncTest(
  'hydration cannot restore authenticated state after a protected request is rejected',
  async () => {
    const { controller } = controllerDouble(async (url) => {
      if (url.endsWith('/api/workspace')) return response(401, { error: 'unauthorized' });
      if (url.includes('/api/tasks/history')) {
        return response(200, { tasks: [{ taskId: 'private-history', status: 'done' }] });
      }
      return response(200, { tasks: [], rootPath: '/private/project', verified: true });
    });
    controller.token = 'expired-token';
    controller.api.setToken(controller.token);
    controller.storage.save(controller.token);
    await controller.hydrate();
    assert.strictEqual(controller.state.connection.auth, 'locked');
    assert.strictEqual(controller.api.hasToken(), false);
    assert.strictEqual(controller.storage.load(), '');
    assert.strictEqual(controller.state.context.workspace, null);
    assert.deepStrictEqual(Object.keys(controller.state.tasks), []);
  }
);

asyncTest('disconnect invalidates a pending connection check', async () => {
  const pending = deferred();
  const { controller } = controllerDouble(() => pending.promise);
  controller.hydrate = async () => {};
  let socketOpened = false;
  controller.openSocket = () => {
    socketOpened = true;
  };
  const connection = controller.connect('old-token');
  controller.disconnect();
  pending.resolve(response(200, { tasks: [] }));
  await connection;
  assert.strictEqual(controller.state.connection.auth, 'locked');
  assert.strictEqual(controller.storage.load(), '');
  assert.strictEqual(socketOpened, false);
});

asyncTest('a rejected old connection cannot clear a newer connection token', async () => {
  const oldResponse = deferred();
  let requests = 0;
  const { controller } = controllerDouble(() => {
    requests += 1;
    return requests === 1 ? oldResponse.promise : Promise.resolve(response(200, {}));
  });
  controller.hydrate = async () => {};
  controller.openSocket = () => {};
  const oldConnection = controller.connect('old-token');
  await controller.connect('new-token');
  oldResponse.resolve(response(401, { error: 'unauthorized' }));
  await oldConnection;
  assert.strictEqual(controller.state.connection.auth, 'ready');
  assert.strictEqual(controller.token, 'new-token');
  assert.strictEqual(controller.storage.load(), 'new-token');
});

asyncTest('disconnect discards an in-flight hydration snapshot', async () => {
  const queue = deferred();
  const queueRequested = deferred();
  const { controller } = controllerDouble((url) => {
    if (url.endsWith('/api/queue/status')) {
      queueRequested.resolve();
      return queue.promise;
    }
    return Promise.resolve(response(200, { tasks: [] }));
  });
  const hydration = controller.hydrate();
  await queueRequested.promise;
  controller.disconnect();
  queue.resolve(response(200, { tasks: [{ taskId: 'old-task', status: 'queued' }] }));
  await hydration;
  assert.strictEqual(controller.state.connection.auth, 'locked');
  assert.deepStrictEqual(controller.state.tasks, {});
  assert.strictEqual(controller.catalog.workspace, null);
});

asyncTest('disconnect discards pending task and history reads', async () => {
  const pending = deferred();
  const { controller } = controllerDouble(() => pending.promise);
  const taskRead = controller.fetchTask('old-task');
  const historyRead = controller.loadHistory(2, true);
  controller.disconnect();
  pending.resolve(
    response(200, {
      taskId: 'old-task',
      status: 'done',
      result: { text: 'private result' },
      tasks: [{ taskId: 'old-task', status: 'done' }],
    })
  );
  await Promise.all([taskRead, historyRead]);
  assert.deepStrictEqual(controller.state.tasks, {});
  assert.deepStrictEqual(controller.state.history.items, []);
});

asyncTest('retired WebSockets cannot deliver events or close a new connection', async () => {
  const { controller, root, timers } = controllerDouble(async () => response(200, {}));
  const sockets = installSocketDouble(root);
  controller.openSocket();
  const oldSocket = sockets[0];
  oldSocket.emit('open');
  controller.stopRealtime();
  controller.openSocket();
  const currentSocket = sockets[1];
  currentSocket.emit('open');
  await oldSocket.emit('message', {
    data: JSON.stringify({
      type: 'taskUpdate',
      taskId: 'old-task',
      status: 'done',
    }),
  });
  oldSocket.emit('close');
  oldSocket.emit('error');
  assert.strictEqual(controller.socket, currentSocket);
  assert.strictEqual(controller.state.connection.socket, 'open');
  assert.deepStrictEqual(controller.state.tasks, {});
  assert.strictEqual(timers.size, 0);
});

asyncTest('natural WebSocket reconnect resubscribes each active task once', async () => {
  const { controller, root, timers } = controllerDouble(async () => response(200, {}));
  const sockets = installSocketDouble(root);
  controller.dispatch({ type: 'UPSERT_TASK', task: { taskId: 'task-1', status: 'executing' } });
  controller.openSocket();
  sockets[0].emit('open');
  controller.subscribeKnownTasks();
  assert.deepStrictEqual(sockets[0].sent, [{ type: 'subscribe', taskId: 'task-1' }]);
  sockets[0].emit('close');
  const reconnectId = controller.socketReconnectTimer;
  const reconnect = timers.get(reconnectId);
  timers.delete(reconnectId);
  reconnect();
  sockets[1].emit('open');
  controller.subscribeKnownTasks();
  assert.deepStrictEqual(sockets[1].sent, [{ type: 'subscribe', taskId: 'task-1' }]);
  assert.strictEqual(timers.size, 0);
});

asyncTest('an in-flight fallback poll cannot restart itself after disconnect', async () => {
  const pending = deferred();
  const { controller, timers } = controllerDouble(() => pending.promise);
  controller.startFallbackPolling();
  const [timerId, tick] = [...timers][0];
  timers.delete(timerId);
  const polling = tick();
  controller.disconnect();
  pending.resolve(response(200, { tasks: [] }));
  await polling;
  assert.strictEqual(controller.state.connection.auth, 'locked');
  assert.strictEqual(timers.size, 0);
});

asyncTest('repeated submit events during an in-flight request create only one task', async () => {
  const pending = deferred();
  const calls = [];
  const { controller } = composerDouble((url, options) => {
    calls.push({ url, options });
    return pending.promise;
  });
  const event = { preventDefault() {} };
  const first = controller.submitTask(event);
  const second = controller.submitTask(event);
  pending.resolve(response(202, { taskId: 'task-1', status: 'accepted' }));
  await Promise.all([first, second]);
  assert.strictEqual(calls.length, 1);
});

asyncTest('retrying an uncertain submission reuses its identity until acceptance', async () => {
  const keys = [];
  const { controller } = composerDouble((_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (keys.length === 1) throw new TypeError('network response lost');
    return Promise.resolve(response(202, { taskId: `task-${keys.length}`, status: 'accepted' }));
  });
  const event = { preventDefault() {} };
  await controller.submitTask(event);
  assert.strictEqual(controller.refs['task-message'].value, '完成原有任务');
  await controller.submitTask(event);
  assert.strictEqual(keys[0], keys[1], 'the retry must recover the same gateway task');
  controller.refs['task-message'].value = '完成原有任务';
  await controller.submitTask(event);
  assert.notStrictEqual(
    keys[1],
    keys[2],
    'a new instruction after acceptance needs a new identity'
  );
});

asyncTest('changing an uncertain instruction creates a distinct submission identity', async () => {
  const keys = [];
  const { controller } = composerDouble((_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    throw new TypeError('network response lost');
  });
  const event = { preventDefault() {} };
  await controller.submitTask(event);
  controller.refs['task-message'].value = '改为另一项任务';
  await controller.submitTask(event);
  assert.notStrictEqual(keys[0], keys[1]);
});

test('browser application source avoids executable HTML and persistent token writes', () => {
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\.insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(source, /localStorage\?*\.setItem|localStorage\.setItem/);
  assert.doesNotMatch(source, /[?&](?:token|auth|authorization)=/i);
  assert.match(source, /sessionStorage/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /interactionRequestId/);
  assert.match(source, /acknowledgeRisk/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /querySelector\('dialog\[open\]'\)/);
});

asyncTest('a storage failure refreshes the same task without retrying its mutation', async () => {
  const calls = [];
  const { controller } = controllerDouble((url, options) => {
    calls.push([url, options.method]);
    if (options.method === 'POST') return response(503, { error: 'Task storage is unavailable' });
    return response(200, {
      taskId: 'storage-task',
      status: 'executing',
      statePersistencePending: true,
    });
  });
  await controller.taskAction({ taskId: 'storage-task' }, 'review', { decision: 'approve' });
  assert.deepStrictEqual(calls, [
    ['http://127.0.0.1:3000/api/task/storage-task/review', 'POST'],
    ['http://127.0.0.1:3000/api/task/storage-task', 'GET'],
  ]);
  assert.strictEqual(controller.state.tasks['storage-task'].statePersistencePending, true);
});

test('pending task cards expose refresh and cancellation retry without stale decisions', () => {
  const { controller } = controllerDouble(() => response(200, {}));
  controller.element = (_tag, _className, text = '') => ({
    text,
    dataset: {},
    children: [],
    append(...children) {
      this.children.push(...children);
    },
  });
  controller.button = (label) => controller.element('button', '', label);
  controller.renderInteraction = () => {
    throw new Error('pending approval must not expose interaction controls');
  };
  const text = (node) => [node.text, ...node.children.map(text)].join(' ');
  for (const status of ['awaiting_review', 'approval_required']) {
    const candidate = stateApi.normalizeTask({
      taskId: 'pending-card',
      status,
      statePersistencePending: true,
    });
    const rendered = text(controller.renderTaskCard(candidate));
    assert.match(rendered, /等待保存状态/);
    assert.match(rendered, /刷新/);
    assert.doesNotMatch(rendered, /批准结果|拒绝|继续|取消/);
  }
  const cancellation = stateApi.normalizeTask({
    taskId: 'pending-cancellation',
    status: 'executing',
    cancelPersistencePending: true,
  });
  assert.match(text(controller.renderTaskCard(cancellation)), /重试取消/);
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
