'use strict';

const assert = require('assert');
const { TraeCNApiClient, PLUGIN_ID } = require('./traecnapi-client');

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

console.log('\n[traecnapi-client.test.js] Running tests...\n');

test('PLUGIN_ID is traecnclaw', () => {
  assert.strictEqual(PLUGIN_ID, 'traecnclaw');
});

test('TraeCNApiClient uses default base URL', () => {
  const client = new TraeCNApiClient({});
  assert.strictEqual(client.baseUrl, 'http://127.0.0.1:8788');
});

test('TraeCNApiClient uses custom base URL from context', () => {
  const client = new TraeCNApiClient({ baseUrl: 'http://custom:9999' });
  assert.strictEqual(client.baseUrl, 'http://custom:9999');
});

test('TraeCNApiClient uses token from context', () => {
  const client = new TraeCNApiClient({ token: 'my-token' });
  assert.strictEqual(client.token, 'my-token');
});

test('TraeCNApiClient has all required methods', () => {
  const client = new TraeCNApiClient({});
  assert.strictEqual(typeof client.getStatus, 'function');
  assert.strictEqual(typeof client.newChat, 'function');
  assert.strictEqual(typeof client.delegate, 'function');
  assert.strictEqual(typeof client.switchMode, 'function');
  assert.strictEqual(typeof client.openProject, 'function');
  assert.strictEqual(typeof client.updateSelf, 'function');
});

test('TraeCNApiClient updateSelf returns plugin ID', async () => {
  const client = new TraeCNApiClient({});
  const result = await client.updateSelf(false);
  assert.strictEqual(result.pluginId, 'traecnclaw');
});

console.log(`\n[traecnapi-client.test.js] Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
