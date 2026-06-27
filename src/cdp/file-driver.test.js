'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { FileDriver } = require('./file-driver');
const { CommandPaletteDriver } = require('./command-palette-driver');

const { createRunner } = require('../shared/test-runner');
const runner = createRunner('file-driver.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;
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

async function makeTempRoot(prefix) {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(root, { recursive: true });
  return root;
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
  const root = await makeTempRoot('filedriver-test');
  const tmp = path.join(root, 'sample.txt');
  const d = new FileDriver(mockClient(), { fileAllowedRoots: [root] });
  const w = await d.writeDisk(tmp, 'hello world');
  assert.strictEqual(w.ok, true);
  const r = await d.readDisk(tmp);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.content, 'hello world');
  const del = await d.deleteDisk(tmp);
  assert.strictEqual(del.ok, true);
  const r2 = await d.readDisk(tmp);
  assert.strictEqual(r2.ok, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('mkdirDisk creates a nested directory', async () => {
  const root = await makeTempRoot('filedriver-mkdir');
  const tmp = path.join(root, 'a', 'b', 'c');
  const d = new FileDriver(mockClient(), { fileAllowedRoots: [root] });
  const m = await d.mkdirDisk(tmp);
  assert.strictEqual(m.ok, true);
  const stat = await fs.stat(tmp);
  assert.strictEqual(stat.isDirectory(), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('listTreeDisk returns dir + file entries', async () => {
  const root = await makeTempRoot('filedriver-tree');
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'b');
  const d = new FileDriver(mockClient(), { fileAllowedRoots: [root] });
  const r = await d.listTreeDisk(root, { maxDepth: 3 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.entries.length >= 3);
  await fs.rm(root, { recursive: true, force: true });
});

test('renameDisk renames a file', async () => {
  const root = await makeTempRoot('filedriver-rename');
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  const d = new FileDriver(mockClient(), { fileAllowedRoots: [root] });
  await d.writeDisk(a, 'x');
  const r = await d.renameDisk(a, b);
  assert.strictEqual(r.ok, true);
  const r2 = await d.readDisk(b);
  assert.strictEqual(r2.content, 'x');
  await d.deleteDisk(b);
  await fs.rm(root, { recursive: true, force: true });
});

test('disk writes outside allowed roots are rejected', async () => {
  const root = await makeTempRoot('filedriver-allowed');
  const outside = path.join(os.tmpdir(), `filedriver-outside-${Date.now()}.txt`);
  const d = new FileDriver(mockClient(), { fileAllowedRoots: [root] });
  const result = await d.writeDisk(outside, 'nope');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'PATH_OUTSIDE_ALLOWED_ROOTS');
  await fs.rm(root, { recursive: true, force: true });
});

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exit(1);
});
