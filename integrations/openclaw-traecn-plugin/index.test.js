'use strict';

const assert = require('assert');
const { toolDefinitions, slashCommands, formatResult, PLUGIN_ID } = require('./index');

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

console.log('\n[index.test.js] Running tests...\n');

test('PLUGIN_ID is traecnclaw', () => {
  assert.strictEqual(PLUGIN_ID, 'traecnclaw');
});

test('toolDefinitions has 6 tools', () => {
  assert.strictEqual(toolDefinitions.length, 6);
});

test('toolDefinitions includes traecn_status', () => {
  assert.ok(toolDefinitions.some(t => t.name === 'traecn_status'));
});

test('toolDefinitions includes traecn_new_chat', () => {
  assert.ok(toolDefinitions.some(t => t.name === 'traecn_new_chat'));
});

test('toolDefinitions includes traecn_delegate', () => {
  assert.ok(toolDefinitions.some(t => t.name === 'traecn_delegate'));
});

test('toolDefinitions includes traecn_switch_mode', () => {
  assert.ok(toolDefinitions.some(t => t.name === 'traecn_switch_mode'));
});

test('toolDefinitions includes traecn_open_project', () => {
  assert.ok(toolDefinitions.some(t => t.name === 'traecn_open_project'));
});

test('toolDefinitions includes traecn_update_self', () => {
  assert.ok(toolDefinitions.some(t => t.name === 'traecn_update_self'));
});

test('traecn_delegate has required task parameter', () => {
  const tool = toolDefinitions.find(t => t.name === 'traecn_delegate');
  assert.ok(tool.parameters.required.includes('task'));
});

test('traecn_switch_mode has required mode parameter', () => {
  const tool = toolDefinitions.find(t => t.name === 'traecn_switch_mode');
  assert.ok(tool.parameters.required.includes('mode'));
});

test('traecn_switch_mode mode is enum with solo and ide', () => {
  const tool = toolDefinitions.find(t => t.name === 'traecn_switch_mode');
  assert.deepStrictEqual(tool.parameters.properties.mode.enum, ['solo', 'ide']);
});

test('slashCommands has 2 commands', () => {
  assert.strictEqual(slashCommands.length, 2);
});

test('slashCommands includes /TraeCN', () => {
  assert.ok(slashCommands.some(c => c.command === '/TraeCN'));
});

test('slashCommands includes /TraeCN process', () => {
  assert.ok(slashCommands.some(c => c.command === '/TraeCN process'));
});

test('formatResult returns text for successful result', () => {
  const result = formatResult({ text: 'Hello from TraeCN', stable: true });
  assert.ok(result.includes('Hello from TraeCN'));
});

test('formatResult shows error prefix for error result', () => {
  const result = formatResult({ error: 'Connection failed' });
  assert.ok(result.includes('[TraeCN Error]'));
  assert.ok(result.includes('Connection failed'));
});

test('formatResult includes process text when different from text', () => {
  const result = formatResult({ text: 'Final answer', processText: 'Thinking...\nFinal answer' });
  assert.ok(result.includes('--- Process ---'));
  assert.ok(result.includes('Thinking...'));
});

test('formatResult includes timeout warning', () => {
  const result = formatResult({ text: 'Partial', timedOut: true });
  assert.ok(result.includes('timed out'));
});

test('all tools have handlers', () => {
  for (const tool of toolDefinitions) {
    assert.strictEqual(typeof tool.handler, 'function', `Tool ${tool.name} missing handler`);
  }
});

test('all slash commands have handlers', () => {
  for (const cmd of slashCommands) {
    assert.strictEqual(typeof cmd.handler, 'function', `Command ${cmd.command} missing handler`);
  }
});

console.log(`\n[index.test.js] Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
