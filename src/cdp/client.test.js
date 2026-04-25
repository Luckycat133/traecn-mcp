'use strict';

const assert = require('assert');
const { CDPClient, BrowserCDPClient, CDPSession } = require('./client');

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

console.log('\n[client.test.js] Running tests...\n');

test('CDPClient constructor sets wsUrl', () => {
  const client = new CDPClient('ws://localhost:9222/devtools/page/abc');
  assert.strictEqual(client.wsUrl, 'ws://localhost:9222/devtools/page/abc');
});

test('CDPClient isConnected is falsy initially', () => {
  const client = new CDPClient('ws://localhost:9222/devtools/page/abc');
  assert.ok(!client.isConnected);
});

test('CDPClient send throws when not connected', () => {
  const client = new CDPClient('ws://localhost:9222/devtools/page/abc');
  assert.throws(() => {
    client.send('Page.navigate', { url: 'http://example.com' });
  }, /not connected/i);
});

test('CDPClient close does not throw when not connected', async () => {
  const client = new CDPClient('ws://localhost:9222/devtools/page/abc');
  await client.close();
  assert.strictEqual(client.isConnected, false);
});

test('CDPClient on/off registers event handlers', () => {
  const client = new CDPClient('ws://localhost:9222/devtools/page/abc');
  const handler = () => {};
  client.on('Page.loadEventFired', handler);
  client.off('Page.loadEventFired', handler);
});

test('BrowserCDPClient constructor sets wsUrl', () => {
  const client = new BrowserCDPClient('ws://localhost:9222/devtools/browser/abc');
  assert.strictEqual(client.wsUrl, 'ws://localhost:9222/devtools/browser/abc');
});

test('BrowserCDPClient isConnected is falsy initially', () => {
  const client = new BrowserCDPClient('ws://localhost:9222/devtools/browser/abc');
  assert.ok(!client.isConnected);
});

test('BrowserCDPClient send throws when not connected', () => {
  const client = new BrowserCDPClient('ws://localhost:9222/devtools/browser/abc');
  assert.throws(() => {
    client.send('Target.getTargets', {});
  }, /not connected/i);
});

test('BrowserCDPClient close does not throw when not connected', async () => {
  const client = new BrowserCDPClient('ws://localhost:9222/devtools/browser/abc');
  await client.close();
});

test('CDPSession constructor sets properties', () => {
  const mockParent = { _ws: null };
  const session = new CDPSession(mockParent, 'session-123', 'target-456');
  assert.strictEqual(session._sessionId, 'session-123');
  assert.strictEqual(session._targetId, 'target-456');
});

console.log(`\n[client.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
