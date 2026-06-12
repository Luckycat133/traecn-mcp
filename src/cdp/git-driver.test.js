'use strict';

const assert = require('assert');
const { GitDriver } = require('./git-driver');
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
        if (expr.indexOf('scm-viewlet') !== -1) {
          return Promise.resolve({ result: { value: JSON.stringify({ ok: true, items: [{ file: 'a.js', status: 'M' }], branch: 'main' }) } });
        }
        if (expr.indexOf('statusbar') !== -1 && expr.indexOf('Git') !== -1) {
          return Promise.resolve({ result: { value: 'main' } });
        }
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[git-driver.test.js] Running tests...\n');

test('constructor: takes client + config + palette + exec', () => {
  const d = new GitDriver(mockClient(), {}, { exec: () => {} });
  assert.ok(d instanceof GitDriver);
});

test('openSCM / stageAll / commit / push route to palette', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new GitDriver(c, {}, { palette });
  return Promise.all([d.openSCM(), d.stageAll(), d.commit(), d.push(), d.pull(), d.sync()]).then(rs => {
    assert.deepStrictEqual(rs.map(r => r.commandId), [
      'workbench.view.scm',
      'workbench.scm.action.stageAll',
      'workbench.scm.action.commit',
      'workbench.scm.action.push',
      'workbench.scm.action.pull',
      'workbench.scm.action.sync'
    ]);
  });
});

test('readStatus parses JSON', () => {
  const d = new GitDriver(mockClient(), {});
  return d.readStatus().then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].file, 'a.js');
    assert.strictEqual(r.items[0].status, 'M');
  });
});

test('commitWithMessage: empty message throws', () => {
  const d = new GitDriver(mockClient(), {});
  return Promise.resolve().then(() => d.commitWithMessage('')).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'INVALID_INPUT'); }
  );
});

test('execGit without deps.exec returns ok:false', () => {
  const d = new GitDriver(mockClient(), {});
  return d.execGit(['status']).then(r => {
    assert.strictEqual(r.ok, false);
    assert.ok(/no exec dep/.test(r.error));
  });
});

test('execGit with deps.exec calls it', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve({ code: 0, stdout: 'On branch main', stderr: '' });
  };
  const d = new GitDriver(mockClient(), {}, { exec });
  return d.execGit(['status'], { cwd: '/x' }).then(r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stdout, 'On branch main');
    assert.strictEqual(calls[0].cmd, 'git');
    assert.deepStrictEqual(calls[0].args, ['status']);
    assert.strictEqual(calls[0].opts.cwd, '/x');
    assert.ok(calls[0].opts.maxBuffer > 0);
  });
});

Promise.all(asyncTests).then(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
