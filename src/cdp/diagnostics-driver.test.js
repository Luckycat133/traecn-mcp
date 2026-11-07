'use strict';

const assert = require('assert');
const { DiagnosticsDriver } = require('./diagnostics-driver');
const { CommandPaletteDriver } = require('./command-palette-driver');

const { createRunner } = require('../shared/test-runner');
const runner = createRunner('diagnostics-driver.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;
function mockClient() {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = (params && params.expression) || '';
        const json = JSON.stringify({ ok: true, count: 3, items: [
          { severity: 'error', file: 'a.js', line: '10', source: 'eslint', message: 'unexpected' },
          { severity: 'warning', file: 'b.js', line: '20', source: 'ts', message: 'unused' },
          { severity: 'info', file: 'c.js', line: '30', source: 'editor', message: 'hint' }
        ] });
        // readModelMarkers uses monaco.editor.getModelMarkers
        if (expr.indexOf('getModelMarkers') !== -1) {
          return Promise.resolve({ result: { value: json } });
        }
        // readAll uses markers-panel / problems-panel
        if (expr.indexOf('markers-panel') !== -1 || expr.indexOf('problems-panel') !== -1 || expr.indexOf('markers') !== -1) {
          return Promise.resolve({ result: { value: json } });
        }
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[diagnostics-driver.test.js] Running tests...\n');

test('openProblems / nextProblem / prevProblem route to palette', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new DiagnosticsDriver(c, {}, { palette });
  return Promise.all([d.openProblems(), d.nextProblem(), d.prevProblem()]).then(rs => {
    assert.deepStrictEqual(rs.map(r => r.commandId), [
      'workbench.actions.view.problems',
      'editor.action.marker.next',
      'editor.action.marker.prev'
    ]);
  });
});

test('readAll parses rows', () => {
  const d = new DiagnosticsDriver(mockClient(), {});
  return d.readAll().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.items[0].severity, 'error');
  });
});

test('readModelMarkers parses Monaco markers', () => {
  const d = new DiagnosticsDriver(mockClient(), {});
  return d.readModelMarkers().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 3);
  });
});

asyncTest('readModelMarkers maps the real Monaco MarkerSeverity values', async () => {
  const client = {
    async send(method, params) {
      assert.strictEqual(method, 'Runtime.evaluate');
      assert.ok(params.expression.includes('getModelMarkers'));
      return {
        result: {
          value: {
            ok: true,
            count: 5,
            items: [1, 2, 4, 8, 99].map(severity => ({ severity }))
          }
        }
      };
    }
  };
  const d = new DiagnosticsDriver(client, {});

  const result = await d.readModelMarkers();

  assert.deepStrictEqual(
    result.items.map(item => item.severity),
    ['hint', 'info', 'warning', 'error', 'unknown']
  );
});

test('count tallies by severity', () => {
  const d = new DiagnosticsDriver(mockClient(), {});
  return d.count().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.error, 1);
    assert.strictEqual(r.warning, 1);
    assert.strictEqual(r.info, 1);
  });
});

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
});
