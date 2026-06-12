'use strict';

const assert = require('assert');
const { SearchDriver } = require('./search-driver');
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
        if (expr.indexOf('search-results') !== -1) {
          return Promise.resolve({ result: { value: JSON.stringify({ ok: true, count: 2, items: [{ file: 'a.js', line: '10', match: 'hello' }, { file: 'b.js', line: '20', match: 'world' }], countText: '2 results' }) } });
        }
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[search-driver.test.js] Running tests...\n');

test('openSearch / findInFiles route to palette', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new SearchDriver(c, {}, { palette });
  return Promise.all([d.openSearch(), d.findInFiles()]).then(rs => {
    assert.deepStrictEqual(rs.map(r => r.commandId), ['workbench.view.search', 'workbench.action.findInFiles']);
  });
});

test('find requires non-empty query', () => {
  const d = new SearchDriver(mockClient(), {});
  return Promise.resolve().then(() => d.find('')).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'INVALID_INPUT'); }
  );
});

test('readResults parses search-result rows', () => {
  const d = new SearchDriver(mockClient(), {});
  return d.readResults(10).then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.items[0].file, 'a.js');
  });
});

Promise.all(asyncTests).then(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
