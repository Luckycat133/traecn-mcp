'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ConfigManager,
  ConfigValidationError,
  createConfigManager,
  CONFIG_SCHEMA,
  DEFAULT_CONFIG,
  LOG_LEVELS
} = require('./config-manager');

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

function asyncTest(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => {
          passed++;
          console.log(`  PASS: ${name}`);
        })
        .catch(err => {
          failed++;
          console.error(`  FAIL: ${name}`);
          console.error(`        ${err.message}`);
        });
    }
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log('\n[config-manager.test.js] Running tests...\n');

test('createConfigManager returns ConfigManager instance', () => {
  const manager = createConfigManager();
  assert.ok(manager instanceof ConfigManager);
});

test('ConfigManager initializes with default config', () => {
  const manager = new ConfigManager();
  const config = manager.getConfig();
  assert.strictEqual(config.logLevel, 'info');
  assert.strictEqual(config.rateLimit.windowMs, 60000);
  assert.strictEqual(config.rateLimit.maxRequests, 60);
});

test('ConfigManager getSchema returns schema', () => {
  const manager = new ConfigManager();
  const schema = manager.getSchema();
  assert.ok(schema.logLevel);
  assert.ok(schema.rateLimit);
  assert.ok(schema.timeout);
  assert.ok(schema.cors);
  assert.ok(schema.plugins);
});

test('ConfigManager validates logLevel enum', () => {
  const manager = new ConfigManager();
  manager.validate({ logLevel: 'debug' });
  manager.validate({ logLevel: 'error' });
});

test('ConfigManager rejects invalid logLevel', () => {
  const manager = new ConfigManager();
  assert.throws(() => {
    manager.validate({ logLevel: 'invalid' });
  }, ConfigValidationError);
});

test('ConfigManager validates rate limit ranges', () => {
  const manager = new ConfigManager();
  manager.validate({
    rateLimit: { windowMs: 5000, maxRequests: 100 }
  });
});

test('ConfigManager rejects rate limit below minimum', () => {
  const manager = new ConfigManager();
  assert.throws(() => {
    manager.validate({
      rateLimit: { windowMs: 500, maxRequests: 100 }
    });
  }, ConfigValidationError);
});

test('ConfigManager rejects rate limit above maximum', () => {
  const manager = new ConfigManager();
  assert.throws(() => {
    manager.validate({
      rateLimit: { windowMs: 700000, maxRequests: 100 }
    });
  }, ConfigValidationError);
});

test('ConfigManager validates boolean types', () => {
  const manager = new ConfigManager();
  manager.validate({
    cors: { enabled: true }
  });
});

test('ConfigManager rejects non-boolean for boolean fields', () => {
  const manager = new ConfigManager();
  assert.throws(() => {
    manager.validate({
      cors: { enabled: 'yes' }
    });
  }, ConfigValidationError);
});

test('ConfigManager validates plugin settings as boolean', () => {
  const manager = new ConfigManager();
  manager.validate({
    plugins: { myPlugin: true, anotherPlugin: false }
  });
});

test('ConfigManager rejects non-boolean plugin values', () => {
  const manager = new ConfigManager();
  assert.throws(() => {
    manager.validate({
      plugins: { myPlugin: 'enabled' }
    });
  }, ConfigValidationError);
});

test('ConfigManager update applies valid changes', () => {
  const manager = new ConfigManager();
  const result = manager.update({ logLevel: 'debug' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(manager.getConfig().logLevel, 'debug');
});

test('ConfigManager update rejects invalid changes', () => {
  const manager = new ConfigManager();
  assert.throws(() => {
    manager.update({ logLevel: 'invalid' });
  }, ConfigValidationError);
});

test('ConfigManager update records changes', () => {
  const manager = new ConfigManager();
  manager.update({ logLevel: 'warn' });
  const history = manager.getHistory();
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].source, 'api');
});

test('ConfigManager update emits configChanged event', () => {
  const manager = new ConfigManager();
  let eventReceived = false;
  manager.on('configChanged', () => { eventReceived = true; });
  manager.update({ logLevel: 'trace' });
  assert.strictEqual(eventReceived, true);
});

test('ConfigManager reset restores defaults', () => {
  const manager = new ConfigManager();
  manager.update({ logLevel: 'error', rateLimit: { maxRequests: 10 } });
  manager.reset();
  const config = manager.getConfig();
  assert.strictEqual(config.logLevel, 'info');
  assert.strictEqual(config.rateLimit.maxRequests, 60);
});

test('ConfigManager reset records history', () => {
  const manager = new ConfigManager();
  manager.reset();
  const history = manager.getHistory();
  assert.ok(history.length >= 1);
  const lastEntry = history[history.length - 1];
  assert.strictEqual(lastEntry.source, 'reset');
});

test('ConfigManager rollback restores previous config', () => {
  const manager = new ConfigManager();
  manager.update({ logLevel: 'error' });
  const result = manager.rollback(1);
  assert.strictEqual(result.success, true);
  assert.strictEqual(manager.getConfig().logLevel, 'info');
});

test('ConfigManager rollback fails with invalid steps', () => {
  const manager = new ConfigManager();
  const result = manager.rollback(10);
  assert.strictEqual(result.success, false);
});

test('ConfigManager rollback updates history index', () => {
  const manager = new ConfigManager();
  manager.update({ logLevel: 'error' });
  manager.update({ logLevel: 'warn' });
  assert.strictEqual(manager.getHistory().length, 2);
  manager.rollback(1);
  manager.update({ logLevel: 'debug' });
  assert.strictEqual(manager.getHistory().length, 2);
});

test('ConfigManager getDiff detects changes', () => {
  const manager = new ConfigManager();
  const config1 = { logLevel: 'error' };
  const diff = manager.getDiff(config1);
  assert.strictEqual(diff.hasDiff, true);
  assert.ok(diff.diff.logLevel);
});

test('ConfigManager getDiff returns no diff for identical configs', () => {
  const manager = new ConfigManager();
  const config = manager.getConfig();
  const diff = manager.getDiff(config);
  assert.strictEqual(diff.hasDiff, false);
  assert.deepStrictEqual(diff.diff, {});
});

test('ConfigManager getAuditLog records changes', () => {
  const manager = new ConfigManager();
  manager.update({ logLevel: 'error' });
  const auditLog = manager.getAuditLog();
  assert.ok(auditLog.length >= 1);
  assert.strictEqual(auditLog[auditLog.length - 1].action, 'update');
});

test('ConfigManager emits configChanged with changes object', () => {
  const manager = new ConfigManager();
  let receivedChanges = null;
  manager.on('configChanged', (data) => { receivedChanges = data.changes; });
  manager.update({ logLevel: 'error' });
  assert.ok(receivedChanges.logLevel);
  assert.strictEqual(receivedChanges.logLevel.previous, 'info');
  assert.strictEqual(receivedChanges.logLevel.next, 'error');
});

test('ConfigManager limits history to maxHistory', () => {
  const manager = new ConfigManager({ maxHistory: 3 });
  for (let i = 0; i < 5; i++) {
    manager.update({ logLevel: LOG_LEVELS[i % LOG_LEVELS.length] });
  }
  const history = manager.getHistory();
  assert.ok(history.length <= 3);
});

test('ConfigManager deep clones config to prevent mutation', () => {
  const manager = new ConfigManager();
  const config1 = manager.getConfig();
  config1.logLevel = 'modified';
  const config2 = manager.getConfig();
  assert.strictEqual(config2.logLevel, 'info');
});

test('ConfigManager validates timeout ranges', () => {
  const manager = new ConfigManager();
  manager.validate({
    timeout: { request: 60000, response: 15000 }
  });
});

test('ConfigManager rejects timeout below minimum', () => {
  const manager = new ConfigManager();
  assert.throws(() => {
    manager.validate({
      timeout: { request: 1000, response: 30000 }
    });
  }, ConfigValidationError);
});

test('ConfigManager handles nested rateLimit updates', () => {
  const manager = new ConfigManager();
  manager.update({ rateLimit: { maxRequests: 100 } });
  const config = manager.getConfig();
  assert.strictEqual(config.rateLimit.maxRequests, 100);
  assert.strictEqual(config.rateLimit.windowMs, 60000);
});

test('ConfigManager handles nested timeout updates', () => {
  const manager = new ConfigManager();
  manager.update({ timeout: { request: 60000 } });
  const config = manager.getConfig();
  assert.strictEqual(config.timeout.request, 60000);
  assert.strictEqual(config.timeout.response, 30000);
});

test('ConfigManager handles nested cors updates', () => {
  const manager = new ConfigManager();
  manager.update({ cors: { allowedOrigins: 'https://example.com' } });
  const config = manager.getConfig();
  assert.strictEqual(config.cors.allowedOrigins, 'https://example.com');
  assert.strictEqual(config.cors.enabled, true);
});

test('ConfigManager logs warning for high rate limit', () => {
  const manager = new ConfigManager();
  const errors = [];
  try {
    manager.validate({
      rateLimit: { windowMs: 1000, maxRequests: 200 }
    });
  } catch (e) {
    errors.push(...e.errors);
  }
  const rateWarning = errors.find(e => e.message && e.message.includes('100 requests/second'));
  assert.ok(rateWarning);
});

test('ConfigManager constructor accepts options', () => {
  const manager = new ConfigManager({
    maxHistory: 10,
    configFile: '/tmp/test-config.json',
    watchEnabled: false
  });
  assert.strictEqual(manager.maxHistory, 10);
});

test('ConfigManager update returns changes object', () => {
  const manager = new ConfigManager();
  const result = manager.update({ logLevel: 'error', rateLimit: { maxRequests: 50 } });
  assert.ok(result.changes.logLevel);
  assert.ok(result.changes.rateLimit);
});

test('ConfigManager update with no changes returns empty changes', () => {
  const manager = new ConfigManager();
  manager.update({ logLevel: 'info' });
  const result = manager.update({ logLevel: 'info' });
  assert.strictEqual(Object.keys(result.changes).length, 0);
});

test('ConfigManager getDiff with custom config2', () => {
  const manager = new ConfigManager();
  const customConfig = {
    logLevel: 'debug',
    rateLimit: { windowMs: 30000, maxRequests: 30 }
  };
  const diff = manager.getDiff(manager.getConfig(), customConfig);
  assert.strictEqual(diff.hasDiff, true);
  assert.ok(diff.diff.logLevel);
  assert.ok(diff.diff.rateLimit);
});

test('ConfigManager rollback emits configChanged', () => {
  const manager = new ConfigManager();
  manager.update({ logLevel: 'debug' });
  let eventReceived = false;
  manager.on('configChanged', () => { eventReceived = true; });
  manager.rollback(1);
  assert.strictEqual(eventReceived, true);
});

test('ConfigManager reset emits configChanged', () => {
  const manager = new ConfigManager();
  let eventReceived = false;
  manager.on('configChanged', () => { eventReceived = true; });
  manager.reset();
  assert.strictEqual(eventReceived, true);
});

test('ConfigManager stopWatching handles null watcher', () => {
  const manager = new ConfigManager({ watchEnabled: false });
  manager.stopWatching();
  assert.strictEqual(manager._watcher, null);
});

test('CONFIG_SCHEMA has all required fields', () => {
  assert.ok(CONFIG_SCHEMA.logLevel);
  assert.ok(CONFIG_SCHEMA.rateLimit);
  assert.ok(CONFIG_SCHEMA.timeout);
  assert.ok(CONFIG_SCHEMA.cors);
  assert.ok(CONFIG_SCHEMA.plugins);
});

test('DEFAULT_CONFIG matches schema defaults', () => {
  assert.strictEqual(DEFAULT_CONFIG.logLevel, CONFIG_SCHEMA.logLevel.default);
  assert.strictEqual(DEFAULT_CONFIG.rateLimit.windowMs, CONFIG_SCHEMA.rateLimit.windowMs.default);
  assert.strictEqual(DEFAULT_CONFIG.rateLimit.maxRequests, CONFIG_SCHEMA.rateLimit.maxRequests.default);
});

test('LOG_LEVELS contains expected values', () => {
  assert.ok(LOG_LEVELS.includes('error'));
  assert.ok(LOG_LEVELS.includes('warn'));
  assert.ok(LOG_LEVELS.includes('info'));
  assert.ok(LOG_LEVELS.includes('debug'));
  assert.ok(LOG_LEVELS.includes('trace'));
});

test('ConfigValidationError has correct properties', () => {
  const errors = [{ path: 'test', message: 'error' }];
  const error = new ConfigValidationError('Validation failed', errors);
  assert.strictEqual(error.name, 'ConfigValidationError');
  assert.strictEqual(error.errors.length, 1);
});

// ── Encrypted-at-rest config (Batch C3) ───────────────────────────────────

test('ConfigManager encrypts secrets when saving with passphrase configured', () => {
  const tmp = path.join(os.tmpdir(), `traecn-cfg-enc-${Date.now()}.json`);
  try {
    const manager = new ConfigManager({
      configFile: tmp,
      encryptionPassphrase: 'unit-test-passphrase'
    });
    manager.update({ secrets: { apiKey: 'sk-plain-1', token: 'tok-plain-2' } });
    const raw = fs.readFileSync(tmp, 'utf8');
    const persisted = JSON.parse(raw);
    // Sensitive values must not appear in plaintext on disk.
    assert.ok(!raw.includes('sk-plain-1'));
    assert.ok(!raw.includes('tok-plain-2'));
    // And they must carry the encryption prefix.
    assert.ok(persisted.secrets.apiKey.startsWith('enc:v1:'));
    assert.ok(persisted.secrets.token.startsWith('enc:v1:'));
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('ConfigManager decrypts secrets when loading from file', () => {
  const tmp = path.join(os.tmpdir(), `traecn-cfg-dec-${Date.now()}.json`);
  try {
    const writer = new ConfigManager({
      configFile: tmp,
      encryptionPassphrase: 'shared-passphrase'
    });
    writer.update({ secrets: { apiKey: 'sk-on-disk' } });

    const reader = new ConfigManager({
      configFile: tmp,
      encryptionPassphrase: 'shared-passphrase'
    });
    assert.strictEqual(reader.getSecret('apiKey'), 'sk-on-disk');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('ConfigManager rejects loading encrypted config without a passphrase', () => {
  const tmp = path.join(os.tmpdir(), `traecn-cfg-nopass-${Date.now()}.json`);
  try {
    const writer = new ConfigManager({
      configFile: tmp,
      encryptionPassphrase: 'some-passphrase'
    });
    writer.update({ secrets: { apiKey: 'sk-on-disk' } });

    // Load with no passphrase: the value stays encrypted in memory.
    const reader = new ConfigManager({ configFile: tmp });
    assert.strictEqual(reader.getSecret('apiKey'), null);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('ConfigManager getSecret returns null for missing or non-string values', () => {
  const manager = new ConfigManager();
  assert.strictEqual(manager.getSecret('nonexistent'), null);
  assert.strictEqual(manager.getSecret(null), null);
  manager._config.secrets.empty = '';
  assert.strictEqual(manager.getSecret('empty'), null);
});

test('ConfigManager validates secrets section is an object', () => {
  const manager = new ConfigManager();
  assert.throws(() => manager.update({ secrets: 'not-an-object' }), /validation/i);
  assert.throws(() => manager.update({ secrets: [] }), /validation/i);
});

test('ConfigManager validates secret values are strings', () => {
  const manager = new ConfigManager();
  assert.throws(() => manager.update({ secrets: { apiKey: 42 } }), /validation/i);
});

test('ConfigManager keeps secrets as plaintext when no passphrase is configured', () => {
  const tmp = path.join(os.tmpdir(), `traecn-cfg-plain-${Date.now()}.json`);
  try {
    const manager = new ConfigManager({ configFile: tmp });
    manager.update({ secrets: { apiKey: 'sk-plain' } });
    const raw = fs.readFileSync(tmp, 'utf8');
    // Without a passphrase, the value is stored as-is. Operators can
    // inspect / hand-edit the file in single-user dev setups.
    assert.ok(raw.includes('sk-plain'));
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

console.log(`\n[config-manager.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
