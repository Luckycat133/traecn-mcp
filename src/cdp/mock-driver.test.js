'use strict';

const assert = require('assert');
const { MockDriver } = require('../cdp/mock-driver');

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

console.log('\n[mock-driver.test.js] Running tests...\n');

test('MockDriver constructor sets default properties', () => {
  const driver = new MockDriver();
  assert.strictEqual(driver.mode, 'solo');
  assert.strictEqual(driver.ready, true);
  assert.deepStrictEqual(driver.mockResponses, []);
  assert.deepStrictEqual(driver.sentMessages, []);
});

test('MockDriver constructor accepts custom responses', () => {
  const driver = new MockDriver({ responses: ['hello', 'world'], mode: 'ide' });
  assert.deepStrictEqual(driver.mockResponses, ['hello', 'world']);
  assert.strictEqual(driver.mode, 'ide');
});

(async () => {
  await asyncTest('findComposer returns mock element', async () => {
    const driver = new MockDriver();
    const result = await driver.findComposer();
    assert.strictEqual(result.nodeId, 1);
    assert.strictEqual(result.matchedSelector, '.mock-composer');
  });

  await asyncTest('findSendButton returns mock element', async () => {
    const driver = new MockDriver();
    const result = await driver.findSendButton();
    assert.strictEqual(result.nodeId, 2);
  });

  await asyncTest('findResponseRegion returns mock element', async () => {
    const driver = new MockDriver();
    const result = await driver.findResponseRegion();
    assert.strictEqual(result.nodeId, 3);
  });

  await asyncTest('findNewChatButton returns mock element', async () => {
    const driver = new MockDriver();
    const result = await driver.findNewChatButton();
    assert.strictEqual(result.nodeId, 4);
  });

  await asyncTest('findModeTabs returns SOLO and IDE', async () => {
    const driver = new MockDriver();
    const tabs = await driver.findModeTabs();
    assert.strictEqual(tabs.length, 2);
    assert.strictEqual(tabs[0].text, 'SOLO');
    assert.strictEqual(tabs[1].text, 'IDE');
  });

  await asyncTest('sendMessage records message', async () => {
    const driver = new MockDriver();
    await driver.sendMessage('hello');
    assert.deepStrictEqual(driver.sentMessages, ['hello']);
  });

  await asyncTest('collectResponse returns default mock response', async () => {
    const driver = new MockDriver();
    const response = await driver.collectResponse();
    assert.strictEqual(response.text, 'Mock response from TraeCN');
    assert.strictEqual(response.stable, true);
  });

  await asyncTest('collectResponse cycles through custom responses', async () => {
    const driver = new MockDriver({ responses: ['first', 'second'] });
    const r1 = await driver.collectResponse();
    const r2 = await driver.collectResponse();
    const r3 = await driver.collectResponse();
    assert.strictEqual(r1.text, 'first');
    assert.strictEqual(r2.text, 'second');
    assert.strictEqual(r3.text, 'first');
  });

  await asyncTest('delegate sends message and collects response', async () => {
    const driver = new MockDriver({ responses: ['delegated response'] });
    const result = await driver.delegate('do something');
    assert.deepStrictEqual(driver.sentMessages, ['do something']);
    assert.strictEqual(result.text, 'delegated response');
  });

  await asyncTest('newChat returns true', async () => {
    const driver = new MockDriver();
    const result = await driver.newChat();
    assert.strictEqual(result, true);
  });

  await asyncTest('switchMode updates mode', async () => {
    const driver = new MockDriver();
    const result = await driver.switchMode('ide');
    assert.strictEqual(result, true);
    assert.strictEqual(driver.mode, 'ide');
  });

  await asyncTest('checkReadiness returns ready state', async () => {
    const driver = new MockDriver();
    const readiness = await driver.checkReadiness();
    assert.strictEqual(readiness.ready, true);
    assert.strictEqual(readiness.composer.matchedSelector, '.mock-composer');
  });

  await asyncTest('checkReadiness returns not ready when set', async () => {
    const driver = new MockDriver();
    driver.ready = false;
    const readiness = await driver.checkReadiness();
    assert.strictEqual(readiness.ready, false);
  });

  console.log(`\n[mock-driver.test.js] Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
