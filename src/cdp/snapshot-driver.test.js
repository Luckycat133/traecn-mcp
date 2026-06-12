'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { SnapshotDriver } = require('./snapshot-driver');

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

function mockClient(evalValue = JSON.stringify({ ok: true, html: '<body></body>', length: 12 })) {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: evalValue } });
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' });
      return Promise.resolve({ result: {} });
    }
  };
}

console.log('\n[snapshot-driver.test.js] Running tests...\n');

test('snapshotDom parses response', () => {
  const d = new SnapshotDriver(mockClient(), {});
  return d.snapshotDom().then(r => {
    assert.strictEqual(r.ok, true);
    assert.ok(r.html);
  });
});

test('snapshotText parses response', () => {
  const d = new SnapshotDriver(mockClient(), {});
  return d.snapshotText().then(r => {
    assert.strictEqual(r.ok, true);
  });
});

test('screenshot writes PNG to disk', () => {
  const tmp = path.join(os.tmpdir(), `snap-test-${Date.now()}.png`);
  const d = new SnapshotDriver(mockClient(), {});
  return d.screenshot(tmp).then(async r => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, tmp);
    const stat = await fs.stat(tmp);
    assert.ok(stat.size > 0);
    await fs.unlink(tmp);
  });
});

test('pageHash returns stable hash', () => {
  const c = mockClient(JSON.stringify('title::url::0::0'));
  const d = new SnapshotDriver(c, {});
  return d.pageHash().then(h1 => {
    return d.pageHash().then(h2 => {
      assert.strictEqual(h1, h2);
      assert.strictEqual(h1.length, 16);
    });
  });
});

Promise.all(asyncTests).then(() => {
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
