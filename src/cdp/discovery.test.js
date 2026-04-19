'use strict';

const assert = require('assert');
const { scoreTarget, discoverTarget, fetchCDPTargets, fetchCDPVersion } = require('./discovery');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log('\n[discovery.test.js] Running tests...\n');

test('scoreTarget gives base score for page type', () => {
  const target = { type: 'page', title: '', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.strictEqual(score, 10);
});

test('scoreTarget adds points for title keyword match', () => {
  const target = { type: 'page', title: 'Trae CN', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.ok(score > 10, 'Score should be higher than base');
});

test('scoreTarget adds points for chat in title', () => {
  const target = { type: 'page', title: 'Chat', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.ok(score >= 25, 'Score should include chat bonus');
});

test('scoreTarget penalizes devtools', () => {
  const target = { type: 'page', title: 'DevTools', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.ok(score < 0, 'Score should be negative for devtools');
});

test('scoreTarget matches multiple keywords', () => {
  const target = { type: 'page', title: 'Trae CN Chat', url: '' };
  const score = scoreTarget(target, ['Trae', 'Trae CN']);
  assert.ok(score > 30, 'Score should be high for multiple matches');
});

test('scoreTarget handles case insensitivity', () => {
  const target = { type: 'page', title: 'TRAE CN', url: '' };
  const score = scoreTarget(target, ['trae']);
  assert.ok(score > 10, 'Score should match case-insensitively');
});

test('fetchCDPTargets rejects on connection failure', async () => {
  try {
    await fetchCDPTargets('127.0.0.1', 1);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('ECONNREFUSED') || err.message.includes('connect'));
  }
});

test('fetchCDPVersion rejects on connection failure', async () => {
  try {
    await fetchCDPVersion('127.0.0.1', 1);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('ECONNREFUSED') || err.message.includes('connect'));
  }
});

console.log(`\n[discovery.test.js] Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
