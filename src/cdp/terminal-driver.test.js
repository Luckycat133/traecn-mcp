'use strict';

const assert = require('assert');
const { TerminalDriver } = require('./terminal-driver');
const { CommandPaletteDriver } = require('./command-palette-driver');

const { createRunner } = require('../shared/test-runner');
const runner = createRunner('terminal-driver.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;
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

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
});
