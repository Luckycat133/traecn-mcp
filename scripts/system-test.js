'use strict';

const assert = require('assert');
const http = require('http');

process.env.TRAECN_ENABLE_MOCK_BRIDGE = '1';
process.env.TRAECN_GATEWAY_TOKEN = 'system-test-token';
process.env.TRAECN_RATE_LIMIT_MAX_REQUESTS = '1000';

const { startGateway } = require('../src/http/gateway');

function request(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      },
      timeout: 5000
    }, res => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        let data = responseBody;
        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  let server;
  try {
    server = await startGateway({ host: '127.0.0.1', port: 0 });
    const port = server.address().port;
    const auth = { Authorization: 'Bearer system-test-token' };

    const status = await request(port, 'GET', '/api/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.data.mockBridge, true);
    assert.strictEqual(status.headers['x-content-type-options'], 'nosniff');

    const unauthorized = await request(port, 'POST', '/api/sessions', {});
    assert.strictEqual(unauthorized.status, 401);

    const session = await request(port, 'POST', '/api/sessions', {}, auth);
    assert.strictEqual(session.status, 201);
    assert.ok(session.data.sessionId);

    const delegate = await request(
      port,
      'POST',
      `/api/sessions/${encodeURIComponent(session.data.sessionId)}/delegate`,
      { task: 'system test task' },
      auth
    );
    assert.strictEqual(delegate.status, 200);
    assert.strictEqual(delegate.data.text, 'Mock response from TraeCN');

    const asyncDelegate = await request(port, 'POST', '/api/delegate-async', { task: 'async task' }, auth);
    assert.strictEqual(asyncDelegate.status, 200);
    assert.strictEqual(asyncDelegate.data.text, 'Mock response from TraeCN');

    const queueStatus = await request(port, 'GET', '/api/queue-status', null, auth);
    assert.strictEqual(queueStatus.status, 200);
    assert.strictEqual(queueStatus.data.queued, false);

    console.log('[system-test] PASS');
  } catch (err) {
    console.error('[system-test] FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(resolve => server.close(resolve));
    }
  }
})();
