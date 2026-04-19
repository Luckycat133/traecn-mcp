'use strict';

const assert = require('assert');
const { DomDriver, getConfig, sanitizeActivityText, DEFAULT_COMPOSER_SELECTORS, DEFAULT_SEND_BUTTON_SELECTORS, DEFAULT_RESPONSE_SELECTORS } = require('./dom-driver');

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

console.log('\n[dom-driver.test.js] Running tests...\n');

test('getConfig returns default composer selectors', () => {
  const config = getConfig();
  assert.ok(Array.isArray(config.composerSelectors));
  assert.ok(config.composerSelectors.length > 0);
});

test('getConfig returns default send button selectors', () => {
  const config = getConfig();
  assert.ok(Array.isArray(config.sendButtonSelectors));
  assert.ok(config.sendButtonSelectors.length > 0);
});

test('getConfig returns default response selectors', () => {
  const config = getConfig();
  assert.ok(Array.isArray(config.responseSelectors));
  assert.ok(config.responseSelectors.length > 0);
});

test('getConfig returns numeric poll interval', () => {
  const config = getConfig();
  assert.strictEqual(typeof config.pollIntervalMs, 'number');
  assert.ok(config.pollIntervalMs > 0);
});

test('getConfig returns numeric timeout', () => {
  const config = getConfig();
  assert.strictEqual(typeof config.timeoutMs, 'number');
  assert.ok(config.timeoutMs > 0);
});

test('getConfig sendTrigger defaults to button', () => {
  delete process.env.TRAECN_SEND_TRIGGER;
  delete process.env.TRAE_SEND_TRIGGER;
  const config = getConfig();
  assert.strictEqual(config.sendTrigger, 'button');
});

test('sanitizeActivityText removes Chinese thinking indicators', () => {
  const result = sanitizeActivityText('正在思考… some text');
  assert.ok(!result.includes('正在思考'));
  assert.ok(result.includes('some text'));
});

test('sanitizeActivityText removes English thinking indicators', () => {
  const result = sanitizeActivityText('Generating… some text');
  assert.ok(!result.includes('Generating'));
  assert.ok(result.includes('some text'));
});

test('sanitizeActivityText handles empty input', () => {
  assert.strictEqual(sanitizeActivityText(''), '');
  assert.strictEqual(sanitizeActivityText(null), '');
  assert.strictEqual(sanitizeActivityText(undefined), '');
});

test('sanitizeActivityText collapses whitespace', () => {
  const result = sanitizeActivityText('hello   world');
  assert.strictEqual(result, 'hello world');
});

test('DEFAULT_COMPOSER_SELECTORS includes textarea', () => {
  assert.ok(DEFAULT_COMPOSER_SELECTORS.includes('textarea'));
});

test('DEFAULT_SEND_BUTTON_SELECTORS includes submit button', () => {
  assert.ok(DEFAULT_SEND_BUTTON_SELECTORS.some(s => s.includes('submit')));
});

test('DEFAULT_RESPONSE_SELECTORS includes assistant class', () => {
  assert.ok(DEFAULT_RESPONSE_SELECTORS.some(s => s.includes('assistant')));
});

test('getConfig respects TRAECN_COMPOSER_SELECTORS env var', () => {
  process.env.TRAECN_COMPOSER_SELECTORS = '.custom-input,textarea';
  const config = getConfig();
  assert.deepStrictEqual(config.composerSelectors, ['.custom-input', 'textarea']);
  delete process.env.TRAECN_COMPOSER_SELECTORS;
});

test('getConfig falls back to TRAE_COMPOSER_SELECTORS', () => {
  delete process.env.TRAECN_COMPOSER_SELECTORS;
  process.env.TRAE_COMPOSER_SELECTORS = '.trae-input';
  const config = getConfig();
  assert.deepStrictEqual(config.composerSelectors, ['.trae-input']);
  delete process.env.TRAE_COMPOSER_SELECTORS;
});

console.log(`\n[dom-driver.test.js] Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
