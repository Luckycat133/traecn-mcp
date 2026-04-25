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

console.log('\n[index.test.js] Running OpenClaw plugin tests...\n');

test('PLUGIN_ID is traecnclaw', () => {
  assert.strictEqual(PLUGIN_ID, 'traecnclaw');
});

test('toolDefinitions is an array with at least 5 tools', () => {
  assert.ok(Array.isArray(toolDefinitions));
  assert.ok(toolDefinitions.length >= 5);
});

test('all tools have name, description, parameters, and handler', () => {
  for (const tool of toolDefinitions) {
    assert.ok(tool.name, `Tool missing name`);
    assert.ok(tool.description, `Tool ${tool.name} missing description`);
    assert.ok(tool.parameters, `Tool ${tool.name} missing parameters`);
    assert.ok(typeof tool.handler === 'function', `Tool ${tool.name} missing handler`);
  }
});

test('required tools are present', () => {
  const names = toolDefinitions.map(t => t.name);
  assert.ok(names.includes('traecn_status'), 'Missing traecn_status');
  assert.ok(names.includes('traecn_delegate'), 'Missing traecn_delegate');
  assert.ok(names.includes('traecn_new_chat'), 'Missing traecn_new_chat');
  assert.ok(names.includes('traecn_switch_mode'), 'Missing traecn_switch_mode');
  assert.ok(names.includes('traecn_switch_model'), 'Missing traecn_switch_model');
  assert.ok(names.includes('traecn_queue_status'), 'Missing traecn_queue_status');
  assert.ok(names.includes('traecn_chat'), 'Missing traecn_chat');
  assert.ok(names.includes('traecn_open_project'), 'Missing traecn_open_project');
});

test('traecn_delegate has required task parameter', () => {
  const delegate = toolDefinitions.find(t => t.name === 'traecn_delegate');
  assert.ok(delegate.parameters.required.includes('task'));
  assert.ok(delegate.parameters.properties.task);
});

test('traecn_switch_model has required model parameter', () => {
  const switchModel = toolDefinitions.find(t => t.name === 'traecn_switch_model');
  assert.ok(switchModel.parameters.required.includes('model'));
});

test('traecn_switch_mode has enum constraint', () => {
  const switchMode = toolDefinitions.find(t => t.name === 'traecn_switch_mode');
  assert.deepStrictEqual(switchMode.parameters.properties.mode.enum, ['solo', 'ide']);
});

test('traecn_chat has required prompt parameter', () => {
  const chat = toolDefinitions.find(t => t.name === 'traecn_chat');
  assert.ok(chat.parameters.required.includes('prompt'));
  assert.ok(chat.parameters.properties.mode.enum.includes('ask'));
  assert.ok(chat.parameters.properties.mode.enum.includes('edit'));
  assert.ok(chat.parameters.properties.mode.enum.includes('agent'));
});

test('slashCommands is an array', () => {
  assert.ok(Array.isArray(slashCommands));
  assert.ok(slashCommands.length >= 1);
});

test('slashCommands have command, description, and handler', () => {
  for (const cmd of slashCommands) {
    assert.ok(cmd.command, 'Command missing command name');
    assert.ok(cmd.description, 'Command missing description');
    assert.ok(typeof cmd.handler === 'function', 'Command missing handler');
  }
});

test('formatResult handles error', () => {
  const result = formatResult({ error: 'test error' });
  assert.ok(result.includes('test error'));
  assert.ok(result.includes('Error'));
});

test('formatResult handles normal response', () => {
  const result = formatResult({ text: 'hello world' });
  assert.strictEqual(result, 'hello world');
});

test('formatResult handles process text', () => {
  const result = formatResult({ text: 'final', processText: 'thinking...' });
  assert.ok(result.includes('final'));
  assert.ok(result.includes('thinking...'));
  assert.ok(result.includes('Process'));
});

test('formatResult handles timeout', () => {
  const result = formatResult({ text: 'partial', timedOut: true });
  assert.ok(result.includes('timed out'));
});

test('formatResult handles empty response', () => {
  const result = formatResult({});
  assert.ok(result.includes('No response'));
});

console.log(`\n[index.test.js] Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
