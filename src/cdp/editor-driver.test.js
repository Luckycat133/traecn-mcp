'use strict';

const assert = require('assert');
const { EditorDriver } = require('./editor-driver');
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
    } else {
      passed++; console.log(`  PASS: ${name}`);
    }
  } catch (err) {
    failed++; console.error(`  FAIL: ${name}: ${err.message}`);
  }
}

function mockClient(opts = {}) {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push({ method, params });
      // Always report palette as open + input present for happy-path tests
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: true } });
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[editor-driver.test.js] Running tests...\n');

test('constructor with no deps: methods throw PALETTE_REQUIRED', () => {
  const d = new EditorDriver(mockClient(), {});
  return Promise.resolve().then(() => d.save()).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'PALETTE_REQUIRED'); }
  );
});

test('constructor with palette: methods delegate', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new EditorDriver(c, {}, { palette });
  return d.save().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.commandId, 'workbench.action.files.save');
  });
});

test('format / saveAll / undo / redo route to palette', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new EditorDriver(c, {}, { palette });
  return Promise.all([
    d.formatDocument(),
    d.saveAll(),
    d.undo(),
    d.redo()
  ]).then(results => {
    assert.deepStrictEqual(
      results.map(r => r.commandId),
      ['editor.action.formatDocument', 'workbench.action.files.saveAll', 'undo', 'redo']
    );
  });
});

test('acceptAll / rejectAll / acceptNext / rejectNext do not require palette', () => {
  const c = mockClient();
  const d = new EditorDriver(c, {});
  // Without palette, these should still try (since they use DOM, not palette)
  return Promise.all([
    d.acceptAll(),
    d.rejectAll(),
    d.acceptNext(),
    d.rejectNext()
  ]).then(results => {
    for (const r of results) {
      assert.ok('ok' in r);
      assert.ok('clicked' in r);
    }
  });
});

test('readApplyState / listActive / readActive / writeActive return parsed JSON', () => {
  const c = mockClient();
  const d = new EditorDriver(c, {});
  return Promise.all([
    d.readApplyState(),
    d.listActive(),
    d.readActive(),
    d.writeActive('hello')
  ]).then(results => {
    for (const r of results) assert.ok(r !== undefined);
  });
});

Promise.all(asyncTests).then(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
