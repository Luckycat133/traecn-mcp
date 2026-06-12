'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { FileDriver } = require('./file-driver');
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

function mockClient() {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: true } });
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[file-driver.test.js] Running tests...\n');

test('constructor: takes client + config + palette', () => {
  const d = new FileDriver(mockClient(), {});
  assert.strictEqual(d.client.constructor.name, 'Object');
  assert.strictEqual(typeof d.fs, 'object'); // require('fs').promises
});

test('commands without palette throw PALETTE_REQUIRED', () => {
  const d = new FileDriver(mockClient(), {});
  return Promise.resolve().then(() => d.save()).then(
    () => { throw new Error('should throw'); },
    err => { assert.strictEqual(err.code, 'PALETTE_REQUIRED'); }
  );
});

test('save / saveAll / saveAs route to palette', () => {
  const c = mockClient();
  const palette = new CommandPaletteDriver(c, {});
  const d = new FileDriver(c, {}, { palette });
  return Promise.all([d.save(), d.saveAll(), d.saveAs()]).then(rs => {
    assert.deepStrictEqual(rs.map(r => r.commandId), [
      'workbench.action.files.save',
      'workbench.action.files.saveAll',
      'workbench.action.files.saveAs'
    ]);
  });
});

test('readDisk / writeDisk / deleteDisk on a real temp file', async () => {
  const tmp = path.join(os.tmpdir(), `filedriver-test-${Date.now()}.txt`);
  const d = new FileDriver(mockClient(), {});
  const w = await d.writeDisk(tmp, 'hello world');
  assert.strictEqual(w.ok, true);
  const r = await d.readDisk(tmp);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.content, 'hello world');
  const del = await d.deleteDisk(tmp);
  assert.strictEqual(del.ok, true);
  const r2 = await d.readDisk(tmp);
  assert.strictEqual(r2.ok, false);
});

test('mkdirDisk creates a nested directory', async () => {
  const tmp = path.join(os.tmpdir(), `filedriver-mkdir-${Date.now()}`, 'a', 'b', 'c');
  const d = new FileDriver(mockClient(), {});
  const m = await d.mkdirDisk(tmp);
  assert.strictEqual(m.ok, true);
  const stat = await fs.stat(tmp);
  assert.strictEqual(stat.isDirectory(), true);
  await fs.rm(path.join(os.tmpdir(), `filedriver-mkdir-${Date.now()}`), { recursive: true, force: true });
});

test('listTreeDisk returns dir + file entries', async () => {
  const root = path.join(os.tmpdir(), `filedriver-tree-${Date.now()}`);
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'b');
  const d = new FileDriver(mockClient(), {});
  const r = await d.listTreeDisk(root, { maxDepth: 3 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.entries.length >= 3);
  await fs.rm(root, { recursive: true, force: true });
});

test('renameDisk renames a file', async () => {
  const a = path.join(os.tmpdir(), `filedriver-rename-a-${Date.now()}.txt`);
  const b = path.join(os.tmpdir(), `filedriver-rename-b-${Date.now()}.txt`);
  const d = new FileDriver(mockClient(), {});
  await d.writeDisk(a, 'x');
  const r = await d.renameDisk(a, b);
  assert.strictEqual(r.ok, true);
  const r2 = await d.readDisk(b);
  assert.strictEqual(r2.content, 'x');
  await d.deleteDisk(b);
});

Promise.all(asyncTests).then(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
