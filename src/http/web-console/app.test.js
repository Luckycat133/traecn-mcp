'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRunner } = require('../../shared/test-runner');
const app = require('./app');

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

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
