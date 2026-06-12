'use strict';

const assert = require('assert');
const { ExtensionDriver } = require('./extension-driver');
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
        if (expr.indexOf('extensions-viewlet') !== -1) {
          return Promise.resolve({ result: { value: JSON.stringify({ ok: true, count: 2, items: [
            { name: 'ESLint', id: 'dbaeumer.vscode-eslint', author: 'Dirk Baeumer', desc: 'Lint', version: '3.0.0', installed: true },
            { name: 'Prettier', id: 'esbenp.prettier-vscode', author: 'Prettier', desc: 'Format', version: '10.0.0', installed: false }
          ] }) } });
        }
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[extension-driver.test.js] Running tests...\n');

test('constructor: takes client + config + palette + exec', () => {
  const d = new ExtensionDriver(mockClient(), {}, { exec: () => {} });
  assert.ok(d instanceof ExtensionDriver);
});

test('openExtensions / install / uninstall / enable / disable route to palette', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new ExtensionDriver(c, {}, { palette });
  return Promise.all([d.openExtensions(), d.install(), d.uninstall(), d.enable(), d.disable()]).then(rs => {
    assert.deepStrictEqual(rs.map(r => r.commandId), [
      'workbench.view.extensions',
      'workbench.extensions.action.installExtension',
      'workbench.extensions.action.uninstallExtension',
      'workbench.extensions.action.enableExtension',
      'workbench.extensions.action.disableExtension'
    ]);
  });
});

test('searchMarketplace requires non-empty query', () => {
  const d = new ExtensionDriver(mockClient(), {});
  return Promise.resolve().then(() => d.searchMarketplace('')).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'INVALID_INPUT'); }
  );
});

test('readVisible parses extension list', () => {
  const d = new ExtensionDriver(mockClient(), {});
  return d.readVisible(50).then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.items[0].id, 'dbaeumer.vscode-eslint');
  });
});

test('listViaCLI uses deps.exec', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args });
    return Promise.resolve({ code: 0, stdout: 'dbaeumer.vscode-eslint@3.0.0\nesbenp.prettier-vscode@10.0.0\n', stderr: '' });
  };
  const d = new ExtensionDriver(mockClient(), {}, { exec });
  return d.listViaCLI().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    assert.deepStrictEqual(calls[0], { cmd: 'trae-cn', args: ['--list-extensions', '--show-versions'] });
  });
});

test('installViaCLI / uninstallViaCLI use deps.exec', () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const d = new ExtensionDriver(mockClient(), {}, { exec });
  return Promise.all([
    d.installViaCLI('foo.bar', '1.2.3'),
    d.uninstallViaCLI('foo.bar')
  ]).then(rs => {
    assert.deepStrictEqual(calls[0], { cmd: 'trae-cn', args: ['--install-extension', 'foo.bar@1.2.3'] });
    assert.deepStrictEqual(calls[1], { cmd: 'trae-cn', args: ['--uninstall-extension', 'foo.bar'] });
  });
});

Promise.all(asyncTests).then(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
