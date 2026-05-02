'use strict';

const assert = require('assert');
const http = require('http');
const { TraeCNApiClient, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TIMEOUT } = require('./traecnapi-client');

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

console.log('\n[traecnapi-client.test.js] Running tests...\n');

test('DEFAULT_HOST is 127.0.0.1', () => {
  assert.strictEqual(DEFAULT_HOST, '127.0.0.1');
});

test('DEFAULT_PORT is 8788', () => {
  assert.strictEqual(DEFAULT_PORT, 8788);
});

test('DEFAULT_TIMEOUT is 120000', () => {
  assert.strictEqual(DEFAULT_TIMEOUT, 120000);
});

test('TraeCNApiClient constructor uses defaults', () => {
  const client = new TraeCNApiClient();
  assert.strictEqual(client.host, DEFAULT_HOST);
  assert.strictEqual(client.port, DEFAULT_PORT);
  assert.strictEqual(client.token, '');
  assert.strictEqual(client.timeout, DEFAULT_TIMEOUT);
});

test('TraeCNApiClient constructor accepts custom options', () => {
  const client = new TraeCNApiClient({ host: '10.0.0.1', port: 9999, token: 'abc', timeout: 5000 });
  assert.strictEqual(client.host, '10.0.0.1');
  assert.strictEqual(client.port, 9999);
  assert.strictEqual(client.token, 'abc');
  assert.strictEqual(client.timeout, 5000);
});

(async () => {
  let server;
  let lastRequest;

  function createMockServer(handler) {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          lastRequest = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body ? JSON.parse(body) : null
          };
          handler(req, res, lastRequest.body);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address().port);
      });
    });
  }

  await asyncTest('getStatus sends GET to /api/status', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'connected' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.getStatus();
    assert.strictEqual(result.data.status, 'connected');
    assert.strictEqual(lastRequest.method, 'GET');
    assert.strictEqual(lastRequest.url, '/api/status?allowAutoStart=false');
    server.close();
  });

  await asyncTest('delegate sends POST to /api/delegate', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'response', stable: true }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.delegate('test task', { includeProcessText: true });
    assert.strictEqual(result.data.text, 'response');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/delegate');
    assert.strictEqual(lastRequest.body.task, 'test task');
    assert.strictEqual(lastRequest.body.includeProcessText, true);
    server.close();
  });

  await asyncTest('switchModel sends POST to /api/switch-model', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, model: 'GLM-5.1' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.switchModel('GLM-5.1');
    assert.strictEqual(result.data.success, true);
    assert.strictEqual(lastRequest.body.model, 'GLM-5.1');
    server.close();
  });

  await asyncTest('checkQueueStatus sends GET to /api/queue-status', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: false }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.checkQueueStatus();
    assert.strictEqual(result.data.queued, false);
    assert.strictEqual(lastRequest.url, '/api/queue-status');
    server.close();
  });

  await asyncTest('settingsRead sends GET with section param', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ section: '模型' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.settingsRead('模型');
    assert.strictEqual(result.data.section, '模型');
    assert.ok(lastRequest.url.startsWith('/api/settings/read?section='));
    server.close();
  });

  await asyncTest('settingsWrite sends POST to settings set endpoint', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ label: 'Auto Save', value: true }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.settingsWrite('通用', { label: 'Auto Save', value: true });
    assert.strictEqual(result.data.label, 'Auto Save');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.url, '/api/settings/set');
    assert.strictEqual(lastRequest.body.section, '通用');
    server.close();
  });

  await asyncTest('token is sent as Bearer auth header', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const client = new TraeCNApiClient({ port, token: 'test-token', timeout: 3000 });
    await client.getStatus();
    assert.strictEqual(lastRequest.headers.authorization, 'Bearer test-token');
    server.close();
  });

  await asyncTest('healthCheck returns true for 200', async () => {
    const port = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'connected' }));
    });
    const client = new TraeCNApiClient({ port, timeout: 3000 });
    const result = await client.healthCheck();
    assert.strictEqual(result, true);
    server.close();
  });

  await asyncTest('healthCheck returns false for connection error', async () => {
    const client = new TraeCNApiClient({ port: 1, timeout: 500 });
    const result = await client.healthCheck();
    assert.strictEqual(result, false);
  });

  console.log(`\n[traecnapi-client.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
