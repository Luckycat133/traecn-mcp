'use strict';

const assert = require('assert');
const { EditorDriver } = require('./editor-driver');
const { CommandPaletteDriver } = require('./command-palette-driver');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('editor-driver.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = r;

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

test('readActive returns ok=true from the model fallback when no editor is registered', () => {
  // Simulate Monaco having models loaded but getEditors() returning [] — the
  // exact state the live editor hits when the workbench is between rendering
  // a file and registering the editor instance with the API.
  const c = mockClient();
  c.send = (method, params) => {
    if (method !== 'Runtime.evaluate') return Promise.resolve({ result: {} });
    if (typeof params.expression !== 'string') return Promise.resolve({ result: { value: true } });
    if (params.expression.includes('window.monaco')) {
      // The polyfill mimics the real getModels() payload: a single model
      // with a known URI, used by the model-fallback branch.
      const payload = JSON.stringify({
        ok: true,
        value: '// file content from model fallback',
        language: 'javascript',
        source: 'model-fallback',
        uri: 'file:///tmp/example.js'
      });
      return Promise.resolve({ result: { value: payload } });
    }
    return Promise.resolve({ result: { value: true } });
  };
  const d = new EditorDriver(c, {});
  return d.readActive().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, 'model-fallback');
    assert.strictEqual(r.uri, 'file:///tmp/example.js');
    assert.strictEqual(r.value, '// file content from model fallback');
  });
});

test('listActive augments with model-only rows when editors are not registered', () => {
  const c = mockClient();
  c.send = (method, params) => {
    if (method !== 'Runtime.evaluate') return Promise.resolve({ result: {} });
    if (typeof params.expression === 'string' && params.expression.includes('getEditors')) {
      // Polyfill: no editors, but getModels returns one model-only entry.
      const rows = [{
        id: null,
        language: 'javascript',
        uri: 'file:///tmp/example.js',
        lineCount: 42,
        hasEditor: false,
        visible: true
      }];
      return Promise.resolve({ result: { value: JSON.stringify(rows) } });
    }
    return Promise.resolve({ result: { value: true } });
  };
  const d = new EditorDriver(c, {});
  return d.listActive().then(rows => {
    assert.ok(Array.isArray(rows));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].uri, 'file:///tmp/example.js');
    assert.strictEqual(rows[0].hasEditor, false);
    assert.strictEqual(rows[0].visible, true);
  });
});

pendingAsyncTests().then(() => {
  summary();
  process.exit(r.failed > 0 ? 1 : 0);
});
