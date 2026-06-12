'use strict';

const assert = require('assert');
const { TerminalDriver } = require('./terminal-driver');
const { CommandPaletteDriver } = require('./command-palette-driver');

let passed = 0, failed = 0;
const asyncTests = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      asyncTests.push(
        Promise.resolve(r)
          .then(() => { passed++; console.log(`  PASS: ${name}`); })
          .catch(err => { failed++; console.error(`  FAIL: ${name}: ${err.message}`); })
      );
    } else { passed++; console.log(`  PASS: ${name}`); }
  } catch (err) { failed++; console.error(`  FAIL: ${name}: ${err.message}`); }
}

function mockClient() {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = (params && params.expression) || '';
        // Return JSON snapshot when the expression contains 'terminal-wrapper' (snapshot call)
        if (expr.indexOf('terminal-wrapper') !== -1) {
          return Promise.resolve({ result: { value: JSON.stringify({ ok: true, present: true, output: 'line1\nline2\nline3', rowCount: 3, tabs: [] }) } });
        }
        // Otherwise return truthy (palette, focus, etc)
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[terminal-driver.test.js] Running tests...\n');

test('constructor: takes client + config + palette', () => {
  const d = new TerminalDriver(mockClient(), {});
  assert.ok(d instanceof TerminalDriver);
});

test('toggleTerminal routes to palette', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new TerminalDriver(c, {}, { palette });
  return d.toggleTerminal().then(r => {
    assert.strictEqual(r.commandId, 'workbench.action.terminal.toggleTerminal');
  });
});

test('send requires non-empty string', () => {
  const d = new TerminalDriver(mockClient(), {});
  return Promise.resolve().then(() => d.send('')).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'INVALID_INPUT'); }
  );
});

test('snapshot returns parsed object', () => {
  const d = new TerminalDriver(mockClient(), {});
  return d.snapshot().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.output, 'line1\nline2\nline3');
  });
});

test('tail returns last N lines', () => {
  const d = new TerminalDriver(mockClient(), {});
  return d.tail(2).then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.tail, 'line2\nline3');
    assert.strictEqual(r.totalLines, 3);
  });
});

test('sendCtrlC / sendCtrlD / sendCtrlL / sendCtrlZ all dispatch keys', () => {
  const c = mockClient();
  const d = new TerminalDriver(c, {});
  return Promise.all([d.sendCtrlC(), d.sendCtrlD(), d.sendCtrlL(), d.sendCtrlZ()]).then(rs => {
    for (const r of rs) {
      assert.ok(['c','d','l','z'].includes(r.key));
    }
  });
});

Promise.all(asyncTests).then(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
