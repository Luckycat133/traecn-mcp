'use strict';

const assert = require('assert');
const { CommandPaletteDriver } = require('./command-palette-driver');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      r.then(() => { passed++; console.log(`  PASS: ${name}`); })
        .catch(err => { failed++; console.error(`  FAIL: ${name}: ${err.message}`); });
      return;
    }
    passed++; console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++; console.error(`  FAIL: ${name}: ${err.message}`);
  }
}

console.log('\n[command-palette-driver.test.js] Running tests...\n');

// Build a mock CDP client that records send() calls.
function mockClient(responses = {}) {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push({ method, params });
      const key = `${method}`;
      if (Object.prototype.hasOwnProperty.call(responses, key)) {
        const r = responses[key];
        return Promise.resolve(typeof r === 'function' ? r(method, params) : r);
      }
      return Promise.resolve({ result: { value: false } });
    }
  };
}

test('constructor takes client and config', () => {
  const c = mockClient();
  const d = new CommandPaletteDriver(c, {});
  assert.ok(d instanceof CommandPaletteDriver);
  assert.strictEqual(d.client, c);
});

test('run throws on empty commandId', () => {
  const c = mockClient();
  const d = new CommandPaletteDriver(c, {});
  return d.run('').then(
    () => { throw new Error('should have thrown'); },
    err => { assert.ok(/required/.test(err.message)); }
  );
});

test('open() dispatches keyboard shortcut for palette', () => {
  const c = mockClient({ 'Runtime.evaluate': { result: { value: false } } });
  const d = new CommandPaletteDriver(c, {});
  return d.open().then(() => {
    const sends = c.calls.filter(x => x.method === 'Input.dispatchKeyEvent');
    assert.ok(sends.length >= 1, 'expected at least one keyboard event');
  });
});

test('run() throws when palette fails to open', () => {
  const c = mockClient({ 'Runtime.evaluate': { result: { value: false } } });
  const d = new CommandPaletteDriver(c, {});
  return d.run('workbench.action.files.save').then(
    () => { throw new Error('should have thrown'); },
    err => { assert.ok(/palette/i.test(err.message)); }
  );
});

test('runSequence runs each command in order', () => {
  // First call: palette opens. Subsequent: each command opens new palette.
  // We'll make the palette always open successfully.
  const c = mockClient({ 'Runtime.evaluate': { result: { value: true } } });
  const d = new CommandPaletteDriver(c, {});
  return d.runSequence(['workbench.action.files.save', 'workbench.action.files.saveAll'])
    .then(results => {
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].commandId, 'workbench.action.files.save');
      assert.strictEqual(results[1].commandId, 'workbench.action.files.saveAll');
    });
});

test('close() no-ops if palette not open', () => {
  const c = mockClient({ 'Runtime.evaluate': { result: { value: false } } });
  const d = new CommandPaletteDriver(c, {});
  return d.close().then(() => {
    // No keyboard events sent
    const sends = c.calls.filter(x => x.method === 'Input.dispatchKeyEvent');
    assert.strictEqual(sends.length, 0);
  });
});

setTimeout(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 100);
