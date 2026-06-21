'use strict';

const assert = require('assert');
const { ApiKeyManager } = require('../shared/api-key-manager');
const { createRunner } = require('./test-runner');
const runner = createRunner('api-key-manager.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[api-key-manager.test.js] Running tests...\n');

test('ApiKeyManager creates key with all required fields', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const result = manager.createKey({ name: 'Test Key' });

  assert.ok(result.keyId, 'keyId should exist');
  assert.ok(result.key, 'key should exist');
  assert.ok(result.keyPrefix, 'keyPrefix should exist');
  assert.ok(result.keyHash, 'keyHash should exist');
  assert.ok(result.createdAt, 'createdAt should exist');
  assert.strictEqual(result.name, 'Test Key');
  assert.deepStrictEqual(result.permissions, ['read']);
});

test('ApiKeyManager generates unique keys', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const key1 = manager.createKey({ name: 'Key 1' });
  const key2 = manager.createKey({ name: 'Key 2' });

  assert.notStrictEqual(key1.key, key2.key);
  assert.notStrictEqual(key1.keyId, key2.keyId);
});

test('ApiKeyManager validates correct key', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { key } = manager.createKey({ name: 'Test Key' });

  const validation = manager.validateKey(key);

  assert.ok(validation.valid, 'Key should be valid');
  assert.ok(validation.keyId, 'keyId should be present');
  assert.ok(validation.permissions, 'permissions should be present');
});

test('ApiKeyManager rejects invalid key', () => {
  const manager = new ApiKeyManager({ enabled: true });
  manager.createKey({ name: 'Test Key' });

  const validation = manager.validateKey('invalid_key');

  assert.ok(!validation, 'Key should be invalid');
});

test('ApiKeyManager rejects null key', () => {
  const manager = new ApiKeyManager({ enabled: true });

  const validation = manager.validateKey(null);

  assert.strictEqual(validation, null);
});

test('ApiKeyManager rejects empty string key', () => {
  const manager = new ApiKeyManager({ enabled: true });

  const validation = manager.validateKey('');

  assert.strictEqual(validation, null);
});

test('ApiKeyManager rejects expired key', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { key, keyId } = manager.createKey({ name: 'Test Key' });

  manager.updateKey(keyId, { expiresInDays: 1 });
  manager.keys.get(keyId).expiresAt = new Date(Date.now() - 1000).toISOString();

  const validation = manager.validateKey(key);

  assert.ok(validation.valid === false, 'Key should be invalid');
  assert.strictEqual(validation.reason, 'expired', 'Reason should be expired');
});

test('ApiKeyManager listKeys returns all keys without full key', () => {
  const manager = new ApiKeyManager({ enabled: true });
  manager.createKey({ name: 'Key 1' });
  manager.createKey({ name: 'Key 2' });

  const keys = manager.listKeys();

  assert.strictEqual(keys.length, 2);
  assert.ok(!keys[0].key, 'key should not be included');
  assert.ok(!keys[0].keyHash, 'keyHash should not be included');
  assert.ok(keys[0].keyPrefix, 'keyPrefix should be included');
  assert.ok(keys[0].keyId, 'keyId should be included');
});

test('ApiKeyManager getKey returns key info', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const created = manager.createKey({ name: 'Test Key' });

  const keyInfo = manager.getKey(created.keyId);

  assert.ok(keyInfo, 'keyInfo should exist');
  assert.strictEqual(keyInfo.name, 'Test Key');
  assert.strictEqual(keyInfo.keyId, created.keyId);
});

test('ApiKeyManager getKey returns null for non-existent key', () => {
  const manager = new ApiKeyManager({ enabled: true });

  const keyInfo = manager.getKey('non_existent');

  assert.strictEqual(keyInfo, null);
});

test('ApiKeyManager revokeKey removes key', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { key, keyId } = manager.createKey({ name: 'Test Key' });

  const revoked = manager.revokeKey(keyId);

  assert.ok(revoked, 'Key should be revoked');
  assert.strictEqual(manager.validateKey(key), null, 'Key should no longer be valid');
});

test('ApiKeyManager revokeKey returns false for non-existent key', () => {
  const manager = new ApiKeyManager({ enabled: true });

  const revoked = manager.revokeKey('non_existent');

  assert.strictEqual(revoked, false);
});

test('ApiKeyManager rotateKey generates new key', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { key: oldKey, keyId } = manager.createKey({ name: 'Test Key' });

  const rotated = manager.rotateKey(keyId);

  assert.ok(rotated, 'rotated key should exist');
  assert.ok(rotated.key, 'new key should exist');
  assert.notStrictEqual(rotated.key, oldKey, 'New key should be different');
  assert.strictEqual(rotated.keyId, keyId, 'keyId should remain same');

  assert.strictEqual(manager.validateKey(oldKey), null, 'Old key should be invalid');
  assert.ok(manager.validateKey(rotated.key).valid, 'New key should be valid');
});

test('ApiKeyManager rotateKey returns null for non-existent key', () => {
  const manager = new ApiKeyManager({ enabled: true });

  const rotated = manager.rotateKey('non_existent');

  assert.strictEqual(rotated, null);
});

test('ApiKeyManager updateKey updates properties', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { keyId } = manager.createKey({ name: 'Old Name', permissions: ['read'] });

  const updated = manager.updateKey(keyId, {
    name: 'New Name',
    permissions: ['read', 'write'],
    expiresInDays: 30
  });

  assert.ok(updated, 'updated should exist');
  assert.strictEqual(updated.name, 'New Name');
  assert.deepStrictEqual(updated.permissions, ['read', 'write']);
  assert.ok(updated.expiresAt, 'expiresAt should be set');
});

test('ApiKeyManager hasPermission checks correctly', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { keyId } = manager.createKey({ name: 'Test Key', permissions: ['read', 'write'] });

  assert.ok(manager.hasPermission(keyId, 'read'), 'Should have read permission');
  assert.ok(manager.hasPermission(keyId, 'write'), 'Should have write permission');
  assert.ok(!manager.hasPermission(keyId, 'admin'), 'Should not have admin permission');
});

test('ApiKeyManager admin permission grants all access', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { keyId } = manager.createKey({ name: 'Admin Key', permissions: ['admin'] });

  assert.ok(manager.hasPermission(keyId, 'read'), 'Admin should have read permission');
  assert.ok(manager.hasPermission(keyId, 'write'), 'Admin should have write permission');
  assert.ok(manager.hasPermission(keyId, 'admin'), 'Admin should have admin permission');
  assert.ok(manager.hasPermission(keyId, 'delegate'), 'Admin should have delegate permission');
});

test('ApiKeyManager hasPermission returns false for non-existent key', () => {
  const manager = new ApiKeyManager({ enabled: true });

  assert.strictEqual(manager.hasPermission('non_existent', 'read'), false);
});

test('ApiKeyManager IP whitelist check - IP in whitelist', () => {
  const manager = new ApiKeyManager({
    enabled: true,
    allowedIPs: [{ type: 'ip', value: '192.168.1.1' }]
  });

  assert.ok(manager.checkIPWhitelist('192.168.1.1'), 'IP should be allowed');
});

test('ApiKeyManager IP whitelist check - IP not in whitelist', () => {
  const manager = new ApiKeyManager({
    enabled: true,
    allowedIPs: [{ type: 'ip', value: '192.168.1.1' }]
  });

  assert.ok(!manager.checkIPWhitelist('192.168.1.2'), 'IP should not be allowed');
});

test('ApiKeyManager IP whitelist - null allows all', () => {
  const manager = new ApiKeyManager({ enabled: true, allowedIPs: null });

  assert.ok(manager.checkIPWhitelist('192.168.1.1'), 'All IPs should be allowed when whitelist is null');
});

test('ApiKeyManager verifySignature validates correctly', () => {
  const manager = new ApiKeyManager({ enabled: true, signatureSecret: 'test-secret' });
  const timestamp = Date.now().toString();
  const body = JSON.stringify({ test: 'data' });
  const signature = manager.generateSignature(body, timestamp);

  assert.ok(manager.verifySignature(body, signature, timestamp), 'Signature should be valid');
});

test('ApiKeyManager verifySignature rejects invalid signature', () => {
  const manager = new ApiKeyManager({ enabled: true, signatureSecret: 'test-secret' });
  const timestamp = Date.now().toString();
  const body = JSON.stringify({ test: 'data' });

  assert.ok(!manager.verifySignature(body, 'invalid-signature', timestamp), 'Signature should be invalid');
});

test('ApiKeyManager verifySignature rejects old timestamp', () => {
  const manager = new ApiKeyManager({
    enabled: true,
    signatureSecret: 'test-secret',
    signatureTimestampWindow: 60000
  });
  const oldTimestamp = (Date.now() - 120000).toString();
  const body = JSON.stringify({ test: 'data' });
  const signature = manager.generateSignature(body, oldTimestamp);

  assert.ok(!manager.verifySignature(body, signature, oldTimestamp), 'Old timestamp should be rejected');
});

test('ApiKeyManager verifySignature returns false when no secret', () => {
  const manager = new ApiKeyManager({ enabled: true, signatureSecret: '' });

  assert.ok(!manager.verifySignature('body', 'sig', '123'), 'Should return false without secret');
});

test('ApiKeyManager keyPrefix is correct length', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { key } = manager.createKey({ name: 'Test Key' });
  const prefix = manager.getKeyPrefix(key);

  assert.strictEqual(prefix.length, 8, 'Key prefix should be 8 characters');
});

test('ApiKeyManager keyHash is deterministic', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const key = 'test_key_123';
  const hash1 = manager.hashKey(key);
  const hash2 = manager.hashKey(key);

  assert.strictEqual(hash1, hash2, 'Same key should produce same hash');
});

test('ApiKeyManager keyHash is different for different keys', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const hash1 = manager.hashKey('key1');
  const hash2 = manager.hashKey('key2');

  assert.notStrictEqual(hash1, hash2, 'Different keys should produce different hashes');
});

test('ApiKeyManager enabled by default when env var set', () => {
  process.env.TRAECN_API_KEYS_ENABLED = '1';
  const manager = new ApiKeyManager();
  assert.strictEqual(manager.enabled, true);
  delete process.env.TRAECN_API_KEYS_ENABLED;
});

test('ApiKeyManager disabled by default', () => {
  delete process.env.TRAECN_API_KEYS_ENABLED;
  delete process.env.TRAE_API_KEYS_ENABLED;
  const manager = new ApiKeyManager({});
  assert.strictEqual(manager.enabled, false);
});

summary();
if (runner.failed > 0) process.exit(1);
