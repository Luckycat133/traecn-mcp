'use strict';

const assert = require('assert');
const { parseEnv, loadEnv } = require('./env');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('env.test.js');
const { test, asyncTest, summary } = r;

console.log('\n[env.test.js] Running tests...\n');

test('parses simple KEY=VALUE', () => {
  const result = parseEnv('FOO=bar');
  assert.strictEqual(result.FOO, 'bar');
});

test('parses empty value', () => {
  const result = parseEnv('EMPTY=');
  assert.strictEqual(result.EMPTY, '');
});

test('skips comments', () => {
  const result = parseEnv('# this is a comment\nKEY=val');
  assert.strictEqual(result.KEY, 'val');
  assert.strictEqual(Object.keys(result).length, 1);
});

test('skips blank lines', () => {
  const result = parseEnv('\n\nKEY=val\n\n');
  assert.strictEqual(result.KEY, 'val');
});

test('handles inline comments after value', () => {
  const result = parseEnv('KEY=value # this is a comment');
  assert.strictEqual(result.KEY, 'value');
});

test('handles double-quoted values', () => {
  const result = parseEnv('KEY="hello world"');
  assert.strictEqual(result.KEY, 'hello world');
});

test('handles single-quoted values', () => {
  const result = parseEnv("KEY='hello world'");
  assert.strictEqual(result.KEY, 'hello world');
});

test('preserves spaces in quoted values', () => {
  const result = parseEnv('KEY="  spaced  "');
  assert.strictEqual(result.KEY, '  spaced  ');
});

test('handles escaped quotes in double-quoted values', () => {
  const result = parseEnv('KEY="say \\"hello\\""');
  assert.strictEqual(result.KEY, 'say "hello"');
});

test('handles multiline double-quoted values', () => {
  const result = parseEnv('KEY="line1\nline2"');
  assert.strictEqual(result.KEY, 'line1\nline2');
});

test('handles value with equals sign', () => {
  const result = parseEnv('KEY=a=b=c');
  assert.strictEqual(result.KEY, 'a=b=c');
});

test('does not overwrite existing env vars', () => {
  process.env.__TRAECN_TEST_EXISTING = 'original';
  const parsed = parseEnv('__TRAECN_TEST_EXISTING=newvalue');
  for (const key of Object.keys(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = parsed[key];
    }
  }
  assert.strictEqual(process.env.__TRAECN_TEST_EXISTING, 'original');
  delete process.env.__TRAECN_TEST_EXISTING;
});

test('sets env vars that do not exist', () => {
  delete process.env.__TRAECN_TEST_NEW;
  const parsed = parseEnv('__TRAECN_TEST_NEW=hello');
  for (const key of Object.keys(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = parsed[key];
    }
  }
  assert.strictEqual(process.env.__TRAECN_TEST_NEW, 'hello');
  delete process.env.__TRAECN_TEST_NEW;
});

test('loadEnv returns empty object when .env file does not exist', () => {
  const result = loadEnv('/nonexistent/path/.env');
  assert.deepStrictEqual(result, {});
});

test('loadEnv returns parsed values from existing file', () => {
  const fs = require('fs');
  const path = require('path');
  const tmpPath = path.join(__dirname, '__test_tmp.env');
  fs.writeFileSync(tmpPath, 'TEST_LOAD_KEY=loaded_value\n', 'utf-8');
  delete process.env.TEST_LOAD_KEY;
  const result = loadEnv(tmpPath);
  assert.strictEqual(result.TEST_LOAD_KEY, 'loaded_value');
  assert.strictEqual(process.env.TEST_LOAD_KEY, 'loaded_value');
  delete process.env.TEST_LOAD_KEY;
  fs.unlinkSync(tmpPath);
});

summary();

if (r.failed > 0) {
  process.exit(1);
}
