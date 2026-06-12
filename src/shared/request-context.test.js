'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const ctx = require('./request-context');

test('generateRequestId returns req-prefixed hex id', () => {
  const id = ctx.generateRequestId();
  assert.match(id, /^req-[a-f0-9]+$/);
  assert.ok(id.length > 8);
});

test('generateRequestId produces unique values', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(ctx.generateRequestId());
  assert.equal(ids.size, 100);
});

test('run() injects default requestId when missing', async () => {
  await ctx.run({}, async () => {
    const id = ctx.getRequestId();
    assert.ok(id);
    assert.match(id, /^req-/);
  });
});

test('run() preserves provided requestId and adds it to get()', async () => {
  await ctx.run({ requestId: 'r-fixed', sessionId: 's-1', authKeyId: 'k-1' }, async () => {
    assert.equal(ctx.getRequestId(), 'r-fixed');
    assert.equal(ctx.get('sessionId'), 's-1');
    assert.equal(ctx.get('authKeyId'), 'k-1');
    const store = ctx.getContext();
    assert.equal(store.requestId, 'r-fixed');
    assert.equal(store.sessionId, 's-1');
  });
});

test('context is isolated between concurrent runs', async () => {
  const N = 50;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(ctx.run({ requestId: `r-${i}` }, async () => {
      // Add jitter to make sure runs interleave.
      await new Promise(r => setTimeout(r, Math.random() * 5));
      assert.equal(ctx.getRequestId(), `r-${i}`);
      return ctx.getRequestId();
    }));
  }
  const results = await Promise.all(promises);
  assert.deepEqual(results, Array.from({ length: N }, (_, i) => `r-${i}`));
});

test('outside of run(), getContext returns null', () => {
  // Force exit of any leftover context.
  assert.equal(ctx.getContext(), null);
  assert.equal(ctx.getRequestId(), null);
  assert.equal(ctx.get('anything'), undefined);
});

test('merge() updates the active context', async () => {
  await ctx.run({ requestId: 'r-merge' }, async () => {
    assert.equal(ctx.merge({ userId: 'u-1', sessionId: 's-2' }), true);
    assert.equal(ctx.get('userId'), 'u-1');
    assert.equal(ctx.get('sessionId'), 's-2');
    assert.equal(ctx.getRequestId(), 'r-merge');
  });
});

test('merge() returns false when no context is active', () => {
  assert.equal(ctx.merge({ foo: 'bar' }), false);
});