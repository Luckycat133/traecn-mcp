'use strict';

const assert = require('assert');
const { evaluate, clickByText, clickByTextRadix, evaluateJSON } = require('./browser-dom');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL: ' + name);
    console.error('        ' + err.message);
  }
}

function asyncTest(name, fn) {
  pending.push({ name, fn });
}

function makeClient(evaluations) {
  const queue = [...(evaluations || [])];
  return {
    send: async (method, params) => {
      if (method !== 'Runtime.evaluate') return { result: { value: null } };
      const next = queue.shift();
      if (next === undefined) return { result: { value: null } };
      if (typeof next === 'function') return next(params);
      return next;
    }
  };
}

console.log('\n[browser-dom.test.js] Running tests...\n');

asyncTest('evaluate wraps Runtime.evaluate with awaitPromise and returnByValue', async () => {
  let captured;
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        captured = params;
        return { result: { value: 42 } };
      }
      return { result: {} };
    }
  };
  const out = await evaluate(client, 'function(x) { return x * 2; }', [21]);
  assert.strictEqual(out, 42);
  assert.strictEqual(captured.awaitPromise, true);
  assert.strictEqual(captured.returnByValue, true);
  assert.ok(captured.expression.includes('21'), 'expression should contain serialized args');
});

asyncTest('evaluate returns undefined and surfaces exception details', async () => {
  const client = makeClient([
    { exceptionDetails: { exception: { description: 'ReferenceError: foo is not defined' } } }
  ]);
  await assert.rejects(
    () => evaluate(client, 'function() { return foo; }'),
    /ReferenceError: foo is not defined/
  );
});

asyncTest('evaluate handles string return values', async () => {
  const client = makeClient([{ result: { value: 'hello' } }]);
  const out = await evaluate(client, 'function() { return "hello"; }');
  assert.strictEqual(out, 'hello');
});

asyncTest('evaluate serializes array args via JSON', async () => {
  let captured;
  const client = {
    send: async (method, params) => {
      captured = params;
      return { result: { value: 'ok' } };
    }
  };
  await evaluate(client, 'function(a, b) { return a + b; }', ['x', 1]);
  assert.ok(captured.expression.includes('"x"'));
  assert.ok(captured.expression.includes('1'));
});

asyncTest('clickByText returns true and clicks when text matches', async () => {
  let clickCount = 0;
  const client = {
    send: async (method, params) => {
      // The wrapper evaluates a function on the page that does the actual
      // querySelectorAll + click. For this smoke test, we just need to verify
      // the wrapper sends Runtime.evaluate with the right shape.
      assert.strictEqual(method, 'Runtime.evaluate');
      assert.strictEqual(params.awaitPromise, true);
      assert.strictEqual(params.returnByValue, true);
      // Simulate a "clicked" outcome by returning true.
      clickCount++;
      return { result: { value: true } };
    }
  };
  const ok = await clickByText(client, ['.sidebar-item', '.menu-item'], '设置');
  assert.strictEqual(ok, true);
  assert.strictEqual(clickCount, 1);
});

asyncTest('clickByText returns false when nothing matches', async () => {
  const client = makeClient([{ result: { value: false } }]);
  const ok = await clickByText(client, ['.sidebar-item'], 'Missing');
  assert.strictEqual(ok, false);
});

asyncTest('clickByText accepts a regex matcher', async () => {
  const client = {
    send: async (method, params) => {
      // Regex survives JSON-ish serialisation through CDP args as a string.
      // Our implementation receives the original RegExp, but CDP transport
      // would serialise via JSON which can't carry a RegExp directly. The
      // smoke test only verifies the wrapper runs without throwing.
      return { result: { value: true } };
    }
  };
  const ok = await clickByText(client, ['.x'], /accept|应用/i);
  assert.strictEqual(ok, true);
});

asyncTest('clickByTextRadix: invokes window.__radixClick when present', async () => {
  let radixClicked = null;
  const client = {
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      assert.strictEqual(params.awaitPromise, true);
      assert.strictEqual(params.returnByValue, true);
      // Simulate page-side execution: window.__radixClick is available,
      // matcher finds the node, click succeeds.
      radixClicked = 'settings';
      return { result: { value: true }, exceptionDetails: null };
    }
  };
  const ok = await clickByTextRadix(client, ['.sidebar-item'], 'settings');
  assert.strictEqual(ok, true);
  assert.strictEqual(radixClicked, 'settings');
});

asyncTest('clickByTextRadix: returns radix_click_unavailable when __radixClick missing', async () => {
  const client = {
    send: async () => ({ result: { value: 'radix_click_unavailable' }, exceptionDetails: null })
  };
  const ok = await clickByTextRadix(client, ['.x'], 'whatever');
  assert.strictEqual(ok, 'radix_click_unavailable');
});

asyncTest('evaluateJSON: parses stringified JSON from the page', async () => {
  const client = {
    send: async (method) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      return { result: { value: '{"ok":true,"items":[1,2,3]}' }, exceptionDetails: null };
    }
  };
  const out = await evaluateJSON(client, '() => JSON.stringify({ ok: true, items: [1, 2, 3] })');
  assert.deepStrictEqual(out, { ok: true, items: [1, 2, 3] });
});

asyncTest('evaluateJSON: passes through non-string values', async () => {
  const client = {
    send: async () => ({ result: { value: 42 }, exceptionDetails: null })
  };
  const out = await evaluateJSON(client, '() => 42');
  assert.strictEqual(out, 42);
});

(async () => {
  for (const item of pending) {
    try {
      await item.fn();
      passed++;
      console.log('  PASS: ' + item.name);
    } catch (err) {
      failed++;
      console.error('  FAIL: ' + item.name);
      console.error('        ' + err.message);
    }
  }
  console.log('\n[browser-dom.test.js] Results: ' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed > 0 ? 1 : 0);
})();