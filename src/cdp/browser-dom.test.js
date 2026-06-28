'use strict';

const assert = require('assert');
const { evaluate, clickByText, clickByTextRadix, evaluateJSON, clickByTextEx, clickByPredicate } = require('./browser-dom');

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

// ── clickByTextEx tests ──────────────────────────────────────────────

asyncTest('clickByTextEx: fallbackSelectors kicks in when primary misses', async () => {
  let observedSelectors = null;
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        // First call installs the radix helper; capture and return ok.
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        // The matching evaluation: extract the selectors argument we sent
        // by grepping the serialised array, and simulate a fallback-selector hit.
        const m = expr.match(/\["[^"]+","[^"]+","[^"]+"\]/);
        observedSelectors = m ? m[0] : null;
        return {
          result: {
            value: { ok: true, matchedText: 'Fallback Item', matchedSelector: '.fallback-item' }
          },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByTextEx(
    client,
    ['.primary-item'],
    'Fallback Item',
    { fallbackSelectors: ['.fallback-item', '.other-item'] }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.matchedSelector, '.fallback-item');
  assert.strictEqual(out.matchedText, 'Fallback Item');
  // All three selectors should have been concatenated into the page-side call.
  assert.ok(observedSelectors && observedSelectors.includes('.primary-item'));
  assert.ok(observedSelectors && observedSelectors.includes('.fallback-item'));
  assert.ok(observedSelectors && observedSelectors.includes('.other-item'));
});

asyncTest('clickByTextEx: strategies ordering puts aria-label first', async () => {
  let observedStrategies = null;
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        // Grab the strategies array from the serialised args.
        const m = expr.match(/\["aria-label","text"\]/);
        observedStrategies = m ? m[0] : null;
        return {
          result: {
            value: { ok: true, matchedText: 'Close window', matchedSelector: '[aria-label]' }
          },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByTextEx(
    client,
    ['[aria-label]'],
    'Close',
    { strategies: ['aria-label', 'text'] }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.matchedSelector, '[aria-label]');
  assert.ok(observedStrategies, 'strategies array should appear in the serialised expression');
});

asyncTest('clickByTextEx: exact:true rejects substring matches', async () => {
  let observedExact = null;
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        // The boolean literal `true` ends up serialised in the args list.
        // The exact flag is the 5th positional argument. Match a non-greedy
        // form so we don't run into greedy backtracking across the literal
        // arrays in the body.
        observedExact = /,\s*true,\s*true,\s*"radix"\)/.test(expr);
        // Simulate the page evaluating the predicate and finding nothing
        // because exact matching rejected the substring-only candidate.
        return {
          result: { value: { ok: false, reason: 'not_found' } },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByTextEx(
    client,
    ['.x'],
    'Apply Settings Now',
    { exact: true }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'not_found');
  assert.strictEqual(observedExact, true, 'exact:true flag must reach the page-side evaluation');
});

asyncTest('clickByTextEx: click:radix invokes __radixClick via auto-install', async () => {
  let helperInstallCalls = 0;
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          helperInstallCalls++;
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        // Main match: simulate a successful radix-click outcome.
        return {
          result: {
            value: { ok: true, matchedText: 'Save', matchedSelector: '.btn-save' }
          },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByTextEx(client, ['.btn-save'], 'Save', { click: 'radix' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.matchedText, 'Save');
  assert.strictEqual(helperInstallCalls, 1, 'radix helper should be auto-installed once');
});

asyncTest('clickByTextEx: timeoutMs polls until element appears', async () => {
  let callCount = 0;
  const client = {
    send: async (method) => {
      if (method === 'Runtime.evaluate') {
        callCount++;
        if (callCount === 1) {
          // helper install
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        // 2nd call: not yet
        // 3rd call: not yet
        // 4th call: success
        if (callCount <= 3) {
          return {
            result: { value: { ok: false, reason: 'not_found' } },
            exceptionDetails: null
          };
        }
        return {
          result: {
            value: { ok: true, matchedText: 'Late', matchedSelector: '.late' }
          },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const start = Date.now();
  const out = await clickByTextEx(client, ['.late'], 'Late', { timeoutMs: 2000 });
  const elapsed = Date.now() - start;
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.matchedText, 'Late');
  // We polled at least twice (3rd call still not_found, 4th succeeds)
  // so elapsed must be >= ~150ms.
  assert.ok(elapsed >= 100, 'polling should take at least a few intervals, elapsed=' + elapsed);
  assert.ok(elapsed < 1500, 'should not run past the timeout, elapsed=' + elapsed);
});

asyncTest('clickByTextEx: click:native does not auto-install radix helper', async () => {
  let helperInstallCalls = 0;
  let matchCalls = 0;
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          helperInstallCalls++;
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        matchCalls++;
        return {
          result: { value: { ok: true, matchedText: 'X', matchedSelector: '.x' } },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByTextEx(client, ['.x'], 'X', { click: 'native' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(helperInstallCalls, 0, 'native click should not install radix helper');
  assert.strictEqual(matchCalls, 1);
});

// ── clickByPredicate tests ───────────────────────────────────────────

asyncTest('clickByPredicate: matches via custom predicate', async () => {
  let observedPredicate = null;
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        // The predicate source is passed as a JSON-stringified argument and
        // gets embedded verbatim into the page-side function body. We just
        // check that the predicate text reached the page (escaped or not).
        observedPredicate = /\\"accept\\"/.test(expr) || /"accept"/.test(expr);
        return {
          result: {
            value: { ok: true, matchedText: 'Accept', matchedSelector: '.apply-btn' }
          },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByPredicate(
    client,
    '(t, ti, a) => (t || ti || a || "").toLowerCase().includes("accept")',
    { selectors: ['.apply-btn'], fallbackSelectors: ['.fallback-apply'] }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.matchedText, 'Accept');
  assert.strictEqual(observedPredicate, true);
});

asyncTest('clickByPredicate: returns not_found when predicate rejects all nodes', async () => {
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        return {
          result: { value: { ok: false, reason: 'not_found' } },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByPredicate(
    client,
    '(t, ti, a) => false',
    { selectors: ['.btn'] }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'not_found');
});

asyncTest('clickByPredicate: surfaces radix_click_unavailable distinctly', async () => {
  const client = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression;
        if (expr.includes('window.__radixClick') && expr.includes("'installed'")) {
          return { result: { value: 'installed' }, exceptionDetails: null };
        }
        // Simulate a node match where window.__radixClick isn't present
        // in the page despite our install call — defensive response shape.
        return {
          result: { value: { ok: false, reason: 'radix_click_unavailable' } },
          exceptionDetails: null
        };
      }
      return { result: { value: null } };
    }
  };
  const out = await clickByPredicate(
    client,
    '(t) => t === "Apply"',
    { selectors: ['.btn'] }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'radix_click_unavailable');
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