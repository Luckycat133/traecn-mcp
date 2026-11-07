'use strict';

const assert = require('assert');
const { CDPClient, BrowserCDPClient, CDPSession, __setWebSocketForTesting } = require('./client');

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

// ---- Async reconnect tests (added in upgrade batch B2) ----
let asyncPassed = 0;
let asyncFailed = 0;

async function asyncTest(name, fn) {
  try {
    await fn();
    asyncPassed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    asyncFailed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.stack || err.message}`);
  }
}

// Poll a predicate every 5ms until it returns truthy or the timeout expires.
async function waitFor(predicate, timeoutMs = 500, intervalMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate not satisfied within ' + timeoutMs + 'ms');
}

// Mock the WebSocket class to avoid real network calls.
class MockWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.listeners = {};
    MockWebSocket.instances.push(this);
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  once(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeListener(ev, fn) {
    if (!this.listeners[ev]) return;
    this.listeners[ev] = this.listeners[ev].filter(h => h !== fn);
  }
  emit(ev, ...args) {
    for (const fn of (this.listeners[ev] || []).slice()) fn(...args);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3; // CLOSED
    this.emit('close', code, Buffer.from(reason));
  }
  send() {}
  triggerOpen() { this.readyState = 1; this.emit('open'); }
  triggerError(err) { this.emit('error', err); }
  // Auto-fail after a small delay if never opened — simulates a server that
  // is reachable but rejects new connections.
  autoFailIfStale(ms = 25) {
    this._failTimer = setTimeout(() => {
      if (this.readyState === 0) this.triggerError(new Error('ECONNREFUSED'));
    }, ms);
  }
}

(async () => {
  // Inject the mock WebSocket via the test seam exposed by client.js.
  __setWebSocketForTesting(MockWebSocket);

  await asyncTest('CDPClient emits disconnect on unexpected close', async () => {
    MockWebSocket.instances = [];
    const client = new CDPClient('ws://test/page/1');
    let disconnectEvent = null;
    client.on('disconnect', (data) => { disconnectEvent = data; });
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    await connectPromise;
    ws.close(1006, 'abnormal');
    // Allow microtask queue to flush.
    await new Promise(r => setImmediate(r));
    assert.ok(disconnectEvent, 'expected disconnect event');
    assert.strictEqual(disconnectEvent.code, 1006);
    await client.close();
  });

  await asyncTest('CDPClient does NOT auto-reconnect by default', async () => {
    MockWebSocket.instances = [];
    const client = new CDPClient('ws://test/page/2');
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    await connectPromise;
    ws.close(1006);
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(MockWebSocket.instances.length, 1, 'no new connection should be opened');
    await client.close();
  });

  await asyncTest('CDPClient auto-reconnects with exponential backoff', async () => {
    MockWebSocket.instances = [];
    const events = [];
    const client = new CDPClient('ws://test/page/3', {
      reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }
    });
    client.on('reconnect-attempt', e => events.push({ type: 'attempt', ...e }));
    client.on('reconnect-success', e => events.push({ type: 'success', ...e }));
    const connectPromise = client.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.triggerOpen();
    await connectPromise;
    // Simulate server kicking us.
    ws1.close(1006);
    await waitFor(() => MockWebSocket.instances.length >= 2, 200);
    MockWebSocket.instances[1].triggerOpen();
    await waitFor(() => events.some(e => e.type === 'success'), 200);
    assert.ok(events.some(e => e.type === 'success'), 'expected reconnect-success event');
    await client.close();
  });

  await asyncTest('CDPClient gives up after maxAttempts', async () => {
    MockWebSocket.instances = [];
    const events = [];
    const client = new CDPClient('ws://test/page/4', {
      reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20 }
    });
    client.on('reconnect-failed', e => events.push({ type: 'failed', ...e }));
    const connectPromise = client.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.triggerOpen();
    await connectPromise;
    ws1.close(1006);
    await waitFor(() => MockWebSocket.instances.length >= 2, 200);
    MockWebSocket.instances[1].triggerError(new Error('connect failed 1'));
    await waitFor(() => MockWebSocket.instances.length >= 3, 200);
    MockWebSocket.instances[2].triggerError(new Error('connect failed 2'));
    await waitFor(() => events.some(e => e.type === 'failed'), 200);
    assert.ok(events.some(e => e.type === 'failed'), 'expected reconnect-failed event');
    await client.close();
  });

  await asyncTest('CDPClient.close() prevents further reconnect attempts', async () => {
    MockWebSocket.instances = [];
    const client = new CDPClient('ws://test/page/5', {
      reconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 }
    });
    const connectPromise = client.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.triggerOpen();
    await connectPromise;
    await client.close();
    // Even though ws is closed by close(), no new connection should spawn.
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(MockWebSocket.instances.length, 1, 'close() must suppress reconnect');
  });

  await asyncTest('BrowserCDPClient also emits disconnect on close', async () => {
    MockWebSocket.instances = [];
    const client = new BrowserCDPClient('ws://test/browser/1');
    let disconnected = false;
    client.on('disconnect', () => { disconnected = true; });
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    await connectPromise;
    ws.close(1006);
    await new Promise(r => setImmediate(r));
    assert.strictEqual(disconnected, true);
    await client.close();
  });

  // Reset the test seam so the rest of the test suite is unaffected.
  __setWebSocketForTesting(null);

  console.log(`[client.test.js] Reconnect tests: ${asyncPassed} passed, ${asyncFailed} failed`);
  const totalFailed = failed + asyncFailed;
  process.exit(totalFailed > 0 ? 1 : 0);
})();

function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
}
