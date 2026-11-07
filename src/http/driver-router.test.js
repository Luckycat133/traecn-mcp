'use strict';

const assert = require('assert');
const { DriverRouter, DRIVER_SPEC } = require('./driver-router');

const { createRunner } = require('../shared/test-runner');
const runner = createRunner('driver-router.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;
// Build a fake DomDriver with a "fake child" for each named driver.
function fakeDriver() {
  const drivers = {};
  for (const name of Object.keys(DRIVER_SPEC)) {
    const actions = Object.keys(DRIVER_SPEC[name]);
    const obj = {};
    for (const a of actions) {
      obj[a] = function(...args) {
        return { _action: a, _args: args, _driver: name };
      };
    }
    drivers[name] = obj;
  }
  return {
    editor: drivers.editor,
    file: drivers.file,
    terminal: drivers.terminal,
    git: drivers.git,
    search: drivers.search,
    diagnostics: drivers.diagnostics,
    snapshot: drivers.snapshot,
    extension: drivers.extension,
    palette: drivers.command
  };
}

console.log('\n[driver-router.test.js] Running tests...\n');

test('constructor requires a dom driver', () => {
  let threw = false;
  try { new DriverRouter(null); } catch { threw = true; }
  assert.ok(threw, 'should throw on null driver');
});

test('invoke editor / save (no-arg) returns driver method result', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  return r.invoke('editor', { action: 'save' }).then(res => {
    assert.strictEqual(res._action, 'save');
    assert.strictEqual(res._driver, 'editor');
    assert.deepStrictEqual(res._args, []);
  });
});

test('invoke editor / writeActive passes positional value', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  return r.invoke('editor', { action: 'writeActive', value: 'hello' }).then(res => {
    assert.strictEqual(res._action, 'writeActive');
    assert.deepStrictEqual(res._args, ['hello']);
  });
});

test('invoke command routes to palette', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  return r.invoke('command', { action: 'run', commandId: 'foo' }).then(res => {
    assert.strictEqual(res._driver, 'command');
    assert.strictEqual(res._action, 'run');
  });
});

test('invoke throws MISSING_ACTION when action omitted', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  return r.invoke('editor', {}).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'MISSING_ACTION'); }
  );
});

test('invoke throws UNKNOWN_DRIVER for unknown driver name', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  return r.invoke('nonexistent', { action: 'x' }).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'UNKNOWN_DRIVER'); }
  );
});

test('invoke throws UNKNOWN_ACTION for unknown action', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  return r.invoke('editor', { action: 'nonexistent' }).then(
    () => { throw new Error('should throw'); },
    err => {
      assert.strictEqual(err.code, 'UNKNOWN_ACTION');
      assert.ok(err.details.available.includes('save'));
    }
  );
});

test('listActions returns spec entries', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  const list = r.listActions('editor');
  assert.ok(list.length > 10);
  assert.ok(list.find(a => a.action === 'writeActive' && a.params.includes('value')));
});

test('all 9 drivers are reachable', () => {
  const dom = fakeDriver();
  const r = new DriverRouter(dom);
  const expected = ['editor', 'file', 'terminal', 'git', 'search', 'diagnostics', 'snapshot', 'extension', 'command'];
  for (const name of expected) {
    const list = r.listActions(name);
    assert.ok(list.length > 0, `${name} should have at least 1 action`);
  }
});

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
});
