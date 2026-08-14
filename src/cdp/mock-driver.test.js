'use strict';

const assert = require('assert');
const { MockDriver } = require('../cdp/mock-driver');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('mock-driver.test.js');
const { test, asyncTest, summary } = r;

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
    assert.deepStrictEqual(result, {
      success: true,
      previousMode: 'solo',
      currentMode: 'ide',
      alreadyInMode: false
    });
    assert.strictEqual(driver.mode, 'ide');
  });

  await asyncTest('detectMode returns current mock mode', async () => {
    const driver = new MockDriver({ mode: 'ide' });
    const result = await driver.detectMode();
    assert.strictEqual(result.mode, 'ide');
    assert.strictEqual(result.confidence, 1);
  });

  await asyncTest('listSoloChats stays inside the mock driver without a CDP client', async () => {
    const driver = new MockDriver();
    assert.deepStrictEqual(await driver.listSoloChats(), {
      mode: 'solo',
      chats: [],
      count: 0
    });
  });

  await asyncTest('switchModel updates current model', async () => {
    const driver = new MockDriver();
    const result = await driver.switchModel('glm');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.model, 'glm');
    assert.strictEqual(driver.model, 'glm');
  });

  await asyncTest('listModels returns deterministic mock choices', async () => {
    const driver = new MockDriver({ model: 'GLM-5.2' });
    assert.deepStrictEqual(await driver.listModels(), {
      current: 'GLM-5.2',
      models: ['GLM-5.2', 'mock-model']
    });
  });

  await asyncTest('getCurrentModel stays inside the mock driver without a CDP client', async () => {
    const driver = new MockDriver({ model: 'GLM-5.2' });
    assert.strictEqual(await driver.getCurrentModel(), 'GLM-5.2');
  });

  await asyncTest('settings mock supports read and set', async () => {
    const driver = new MockDriver();
    const tab = await driver.settings.switchTab('general');
    const content = await driver.settings.getContent();
    const setResult = await driver.settings.set('Mock setting', false);
    assert.deepStrictEqual(tab, { tab: 'settings', section: 'general' });
    assert.strictEqual(content.items.length, 1);
    assert.strictEqual(setResult.success, true);
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

  summary();
  process.exit(r.failed > 0 ? 1 : 0);
})();
