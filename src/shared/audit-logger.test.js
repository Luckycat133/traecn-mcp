'use strict';

const assert = require('assert');
const { AuditLogger } = require('../shared/audit-logger');
const { createRunner } = require('./test-runner');
const runner = createRunner('audit-logger.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[audit-logger.test.js] Running tests...\n');

const mockReq = {
  method: 'POST',
  url: '/api/test',
  headers: {
    'x-forwarded-for': '192.168.1.100'
  },
  socket: { remoteAddress: '127.0.0.1' }
};

test('AuditLogger logs entry with required fields', () => {
  const logger = new AuditLogger({ enabled: true });
  const entry = logger.log({
    action: 'test.action',
    resource: '/api/test',
    req: mockReq
  });

  assert.ok(entry.timestamp, 'timestamp should exist');
  assert.ok(entry.id, 'id should exist');
  assert.strictEqual(entry.action, 'test.action');
  assert.strictEqual(entry.resource, '/api/test');
  assert.ok(entry.ip, 'ip should exist');
  assert.strictEqual(entry.status, 'success');
});

test('AuditLogger extracts IP from x-forwarded-for header', () => {
  const logger = new AuditLogger({ enabled: true });
  const entry = logger.log({
    action: 'test.action',
    req: mockReq
  });

  assert.strictEqual(entry.ip, '192.168.1.100');
});

test('AuditLogger extracts IP from socket when no forwarded header', () => {
  const logger = new AuditLogger({ enabled: true });
  const req = {
    headers: {},
    socket: { remoteAddress: '10.0.0.1' }
  };
  const entry = logger.log({
    action: 'test.action',
    req
  });

  assert.strictEqual(entry.ip, '10.0.0.1');
});

test('AuditLogger extracts user from API key', () => {
  const logger = new AuditLogger({ enabled: true });
  const entry = logger.log({
    action: 'test.action',
    req: mockReq,
    keyId: 'key_123'
  });

  assert.deepStrictEqual(entry.user, { type: 'api_key', id: 'key_123' });
});

test('AuditLogger extracts user from x-user-id header', () => {
  const logger = new AuditLogger({ enabled: true });
  const req = {
    headers: { 'x-user-id': 'user_456' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  const entry = logger.log({
    action: 'test.action',
    req
  });

  assert.deepStrictEqual(entry.user, { type: 'user', id: 'user_456' });
});

test('AuditLogger defaults to anonymous user', () => {
  const logger = new AuditLogger({ enabled: true });
  const entry = logger.log({
    action: 'test.action',
    req: mockReq
  });

  assert.deepStrictEqual(entry.user, { type: 'anonymous', id: null });
});

test('AuditLogger sanitizes sensitive params', () => {
  const logger = new AuditLogger({ enabled: true });
  const entry = logger.log({
    action: 'test.action',
    req: mockReq,
    params: {
      password: 'secret123',
      username: 'admin',
      token: 'abc123'
    }
  });

  assert.strictEqual(entry.params.password, '[REDACTED]');
  assert.strictEqual(entry.params.token, '[REDACTED]');
  assert.strictEqual(entry.params.username, 'admin');
});

test('AuditLogger sanitizes nested sensitive params', () => {
  const logger = new AuditLogger({ enabled: true });
  const entry = logger.log({
    action: 'test.action',
    req: mockReq,
    params: {
      data: {
        apiKey: 'secret_key',
        name: 'Test'
      }
    }
  });

  assert.strictEqual(entry.params.data.apiKey, '[REDACTED]');
  assert.strictEqual(entry.params.data.name, 'Test');
});

test('AuditLogger query filters by action', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'action.a', req: mockReq });
  logger.log({ action: 'action.b', req: mockReq });
  logger.log({ action: 'action.a', req: mockReq });

  const result = logger.query({ action: 'action.a' });

  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.logs.length, 2);
});

test('AuditLogger query filters by userId', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test', req: mockReq, keyId: 'key_a' });
  logger.log({ action: 'test', req: mockReq, keyId: 'key_b' });

  const result = logger.query({ userId: 'key_a' });

  assert.strictEqual(result.total, 1);
});

test('AuditLogger query filters by IP', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test', ip: '192.168.1.1' });
  logger.log({ action: 'test', ip: '192.168.1.2' });

  const result = logger.query({ ip: '192.168.1.1' });

  assert.strictEqual(result.total, 1);
});

test('AuditLogger query filters by status', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test', status: 'success' });
  logger.log({ action: 'test', status: 'failure' });

  const result = logger.query({ status: 'failure' });

  assert.strictEqual(result.total, 1);
});

test('AuditLogger query filters by date range', () => {
  const logger = new AuditLogger({ enabled: true });
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  logger.log({ action: 'test', timestamp: yesterday.toISOString() });
  logger.log({ action: 'test', timestamp: now.toISOString() });
  logger.log({ action: 'test', timestamp: tomorrow.toISOString() });

  const result = logger.query({
    startDate: yesterday.toISOString(),
    endDate: tomorrow.toISOString()
  });

  assert.strictEqual(result.total, 3);
});

test('AuditLogger query applies pagination', () => {
  const logger = new AuditLogger({ enabled: true });
  for (let i = 0; i < 20; i++) {
    logger.log({ action: 'test' });
  }

  const result = logger.query({ limit: 5, offset: 0 });

  assert.strictEqual(result.logs.length, 5);
  assert.strictEqual(result.total, 20);
  assert.strictEqual(result.limit, 5);
  assert.strictEqual(result.offset, 0);
});

test('AuditLogger query pagination with offset', () => {
  const logger = new AuditLogger({ enabled: true });
  for (let i = 0; i < 10; i++) {
    logger.log({ action: 'test' });
  }

  const result = logger.query({ limit: 3, offset: 5 });

  assert.strictEqual(result.logs.length, 3);
  assert.strictEqual(result.offset, 5);
});

test('AuditLogger sorts by timestamp descending', () => {
  const logger = new AuditLogger({ enabled: true });
  const now = new Date();
  const earlier = new Date(now.getTime() - 1000);
  const later = new Date(now.getTime() + 1000);

  logger.log({ action: 'test', timestamp: earlier.toISOString() });
  logger.log({ action: 'test', timestamp: later.toISOString() });

  const result = logger.query({});

  assert.ok(new Date(result.logs[0].timestamp) >= new Date(result.logs[1].timestamp));
});

test('AuditLogger exportToJSON returns valid JSON', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test', req: mockReq });
  logger.log({ action: 'test', req: mockReq });

  const json = logger.exportToJSON({});

  assert.ok(json, 'JSON should not be empty');
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed), 'Should be an array');
  assert.strictEqual(parsed.length, 2);
});

test('AuditLogger exportToCSV returns valid CSV', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test.action', req: mockReq });

  const csv = logger.exportToCSV({});

  assert.ok(csv.includes('timestamp,id,action'), 'CSV should have headers');
  assert.ok(csv.includes('test.action'), 'CSV should have action');
});

test('AuditLogger exportToCSV escapes commas in values', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test,action', req: mockReq });

  const csv = logger.exportToCSV({});

  assert.ok(csv.includes('"test,action"'), 'Commas should be escaped');
});

test('AuditLogger getStats returns correct counts', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'action.a' });
  logger.log({ action: 'action.b' });
  logger.log({ action: 'action.a' });

  const stats = logger.getStats();

  assert.strictEqual(stats.totalLogs, 3);
  assert.ok(typeof stats.last24Hours === 'number');
  assert.ok(typeof stats.actionCounts === 'object');
  assert.ok(stats.actionCounts['action.a'] === 2);
  assert.ok(stats.actionCounts['action.b'] === 1);
});

test('AuditLogger clear removes all logs', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test' });
  logger.log({ action: 'test' });

  assert.strictEqual(logger.logs.length, 2);

  logger.clear();

  assert.strictEqual(logger.logs.length, 0);
});

test('AuditLogger disabled does not log', () => {
  const logger = new AuditLogger({ enabled: false });
  const entry = logger.log({ action: 'test' });

  assert.strictEqual(entry, undefined);
  assert.strictEqual(logger.logs.length, 0);
});

test('AuditLogger logKeyCreate records correct action', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.logKeyCreate('key_123', mockReq);

  assert.strictEqual(logger.logs.length, 1);
  assert.strictEqual(logger.logs[0].action, 'key.create');
  assert.strictEqual(logger.logs[0].keyId, 'key_123');
});

test('AuditLogger logKeyRevoke records correct action', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.logKeyRevoke('key_456', mockReq);

  assert.strictEqual(logger.logs.length, 1);
  assert.strictEqual(logger.logs[0].action, 'key.revoke');
  assert.strictEqual(logger.logs[0].keyId, 'key_456');
});

test('AuditLogger logKeyRotate records correct action', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.logKeyRotate('key_789', mockReq);

  assert.strictEqual(logger.logs.length, 1);
  assert.strictEqual(logger.logs[0].action, 'key.rotate');
  assert.strictEqual(logger.logs[0].keyId, 'key_789');
});

test('AuditLogger logAuthFailure records correct action', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.logAuthFailure(mockReq, 'invalid_token');

  assert.strictEqual(logger.logs.length, 1);
  assert.strictEqual(logger.logs[0].action, 'auth.failure');
  assert.strictEqual(logger.logs[0].error, 'invalid_token');
  assert.strictEqual(logger.logs[0].status, 'failure');
});

test('AuditLogger logRequest creates request log entry', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.logRequest(mockReq, {
    action: 'http.request',
    resource: '/api/test',
    params: { id: '123' }
  });

  assert.strictEqual(logger.logs.length, 1);
  assert.strictEqual(logger.logs[0].action, 'http.request');
  assert.strictEqual(logger.logs[0].method, 'POST');
});

test('AuditLogger query filters by resource', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({ action: 'test', resource: '/api/users/123' });
  logger.log({ action: 'test', resource: '/api/posts/456' });

  const result = logger.query({ resource: 'users' });

  assert.strictEqual(result.total, 1);
});

test('AuditLogger includes metadata in log entry', () => {
  const logger = new AuditLogger({ enabled: true });
  logger.log({
    action: 'test',
    metadata: { customField: 'value', count: 42 }
  });

  assert.strictEqual(logger.logs[0].metadata.customField, 'value');
  assert.strictEqual(logger.logs[0].metadata.count, 42);
});

summary();
if (runner.failed > 0) process.exit(1);
