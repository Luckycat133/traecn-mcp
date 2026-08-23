'use strict';

/**
 * Metadata quality gate for the contract-v5 MCP tools.
 *
 * Fails when tool names/order drift, metadata loses accuracy, declared
 * output schemas stop matching representative gateway payloads, or removed
 * lifecycle/profile tools reappear. See
 * .codex/skills/traecnclaw-development/references/mcp-product-design.md.
 */

const assert = require('assert');
const { MCP_CONTRACT_VERSION, MCP_TOOL_NAMES } = require('./contract');
const { MCP_TOOLS, TOOL_TITLES, TOOL_TASK_SUPPORT } = require('./tool-metadata');
const { TOOL_OUTPUT_SCHEMAS, ERROR_RESULT_SCHEMA } = require('./output-schemas');
const { asMcpContent, asMcpError, describeToolExecutionError, unwrapGatewayResult } = require('./tools');
const { callTool } = require('../../mcp-server');

const toolsByName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));

function checkTypes(value, schema) {
  const problems = [];
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (!expected.some(type => type === actual)) {
      problems.push(`expected ${expected.join('|')} but got ${actual}`);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`value ${JSON.stringify(value)} does not match const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      problems.push(...checkTypes(item, schema.items).map(problem => `[${index}] ${problem}`));
    });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)
      && (schema.type === 'object' || schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties || {})) {
      if (value[name] === undefined) continue;
      problems.push(...checkTypes(value[name], property).map(problem => `${name}.${problem}`));
    }
    for (const name of schema.required || []) {
      if (value[name] === undefined) problems.push(`missing required field "${name}"`);
    }
  }
  return problems;
}

// Representative gateway payloads per tool, taken from the handler catalog
// (src/http/handlers/*, src/http/gateway.js).
const REPRESENTATIVE_RESULTS = {
  traecn_send_message: { taskId: 'task-1', status: 'accepted' },
  traecn_get_task: {
    taskId: 'task-1', status: 'done', historyStatus: 'completed', createdAt: 1755800000000,
    elapsed: 4200, completedAt: 1755800004200, message: '完成', fromHistory: true,
    metadata: {}, stepCount: 3, result: { text: 'done', stable: true },
    detailLevel: 'result'
  },
  traecn_cancel_task: { taskId: 'task-1', status: 'cancelled', stopResult: { success: true } },
  traecn_stop_generation: { success: true, conversationId: 'chat-1', scope: 'active_solo_conversation' },
  traecn_open_workspace: {
    success: true, projectPath: '/tmp/demo', verifiedWorkspace: '/tmp/demo',
    alreadyRunning: true, reusedWindow: true, cdp: { host: '127.0.0.1', port: 9222 }
  },
  traecn_list_models: { current: 'GLM-5.1', models: ['GLM-5.1', 'DeepSeek-V3.1-Terminus'] },
  traecn_select_model: {
    success: true, model: 'GLM-5.1', requestedModel: 'GLM-5.1', previousModel: null,
    alreadySelected: false, switchResult: 'switched', queued: false, running: false,
    canSubmit: true, queueDetails: null
  },
  traecn_select_mode: { success: true, mode: 'solo', previousMode: 'ide', alreadyInMode: false },
  traecn_list_setting_sections: { sections: ['通用', '模型'] },
  traecn_list_settings: { section: '通用', sections: ['通用'], items: [] },
  traecn_list_setting_options: { section: '通用', label: '语言', options: ['中文', 'English'] },
  traecn_set_setting_toggle: { label: '自动保存', value: true, result: 'applied' },
  traecn_select_setting_option: { label: '语言', value: '中文', result: 'applied' },
  traecn_set_setting_text: { label: '字体大小', value: '14', result: 'applied' },
  traecn_list_conversations: {
    mode: 'solo',
    conversations: [{ id: 'chat-1', title: 'Demo', active: true }]
  },
  traecn_create_conversation: { action: 'create', success: true },
  traecn_select_conversation: { action: 'select', conversationId: 'chat-1', success: true },
  traecn_delete_conversation: { action: 'delete', conversationId: 'chat-1', deleted: 1, recoverable: false },
  traecn_answer_question: { success: true, resumedTaskIds: ['task-1'] },
  traecn_decide_approval: { success: false, error: 'approval_command_mismatch' }
};

const EXPECTED_ANNOTATIONS = {
  traecn_send_message: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  traecn_get_task: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_cancel_task: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  traecn_stop_generation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  traecn_open_workspace: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traecn_list_models: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_select_model: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_select_mode: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_list_setting_sections: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_list_settings: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_list_setting_options: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_set_setting_toggle: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_select_setting_option: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traecn_set_setting_text: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traecn_list_conversations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traecn_create_conversation: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traecn_select_conversation: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traecn_delete_conversation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  traecn_answer_question: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traecn_decide_approval: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
};

(async () => {
  // Contract boundary: exact names in frozen order.
  assert.strictEqual(MCP_CONTRACT_VERSION, 5);
  assert.deepStrictEqual(MCP_TOOLS.map(tool => tool.name), [...MCP_TOOL_NAMES]);
  assert.strictEqual(MCP_TOOL_NAMES.length, 20);

  // Removed profile and lifecycle surfaces must never reappear as tools.
  const forbiddenNamePattern = /profile|wait|poll|probe|adopt|recover|queue_maintenance|batch|command/;
  for (const name of MCP_TOOL_NAMES) {
    assert.ok(!forbiddenNamePattern.test(name), `unexpected lifecycle tool reappeared: ${name}`);
  }

  for (const tool of MCP_TOOLS) {
    // Titles and descriptions stay present, distinct, and implementation-free.
    assert.ok(tool.title, `${tool.name} lacks a title`);
    assert.strictEqual(tool.title, TOOL_TITLES[tool.name]);
    assert.ok(tool.description && tool.description.length >= 80, `${tool.name} description too thin`);
    assert.ok(!/CDP|selector|DOM|Runtime\.evaluate/i.test(tool.description),
      `${tool.name} description leaks implementation details`);

    // Input schemas fully describe their arguments.
    const inputSchema = tool.inputSchema;
    assert.strictEqual(inputSchema.additionalProperties, false, `${tool.name} input must reject extra keys`);
    const properties = inputSchema.properties || {};
    for (const required of inputSchema.required || []) {
      assert.ok(Object.hasOwn(properties, required), `${tool.name} requires unknown argument ${required}`);
    }
    for (const [name, property] of Object.entries(properties)) {
      assert.ok(property.description, `${tool.name}.${name} lacks an operational description`);
    }

    // Output schemas are specific, documented, and include the common fields.
    const outputSchema = tool.outputSchema;
    assert.strictEqual(outputSchema, TOOL_OUTPUT_SCHEMAS[tool.name], `${tool.name} has a generic or missing output schema`);
    assert.ok(outputSchema.description, `${tool.name} output schema lacks a description`);
    for (const commonField of ['code', 'nextAction', 'retryable', 'message']) {
      assert.ok(Object.hasOwn(outputSchema.properties, commonField),
        `${tool.name} output schema lacks common field ${commonField}`);
    }

    // Representative results validate against the declared types.
    const fixture = REPRESENTATIVE_RESULTS[tool.name];
    assert.ok(fixture, `no representative payload for ${tool.name}`);
    const problems = checkTypes(fixture, outputSchema);
    assert.deepStrictEqual(problems, [], `${tool.name} representative result violates its output schema`);

    // Task support and annotations match characterized behavior.
    assert.strictEqual(tool.execution.taskSupport, TOOL_TASK_SUPPORT[tool.name] || 'forbidden');
    assert.deepStrictEqual(tool.annotations, EXPECTED_ANNOTATIONS[tool.name]);
  }

  assert.strictEqual(TOOL_TASK_SUPPORT.traecn_send_message, 'optional');
  assert.strictEqual(new Set(MCP_TOOLS.map(tool => tool.title)).size, 20, 'titles must be unique');

  // Error paths share one structured, actionable shape.
  const timeoutError = describeToolExecutionError(new Error('Request timeout'));
  assert.strictEqual(timeoutError.code, 'GATEWAY_UNREACHABLE');
  assert.strictEqual(timeoutError.retryable, true);
  const validationError = describeToolExecutionError(new Error('Missing required argument: taskId'));
  assert.strictEqual(validationError.code, 'INVALID_ARGUMENTS');
  assert.strictEqual(validationError.retryable, false);
  for (const detail of [
    describeToolExecutionError(new Error('Request timeout')),
    describeToolExecutionError(new Error('Missing required argument: taskId')),
    describeToolExecutionError(new Error('something unexpected'))
  ]) {
    assert.ok(detail.code && detail.message && detail.nextAction);
    assert.strictEqual(typeof detail.retryable, 'boolean');
  }

  const toolFailure = asMcpError(new Error('Request timeout'));
  assert.strictEqual(toolFailure.isError, true);
  assert.deepStrictEqual(checkTypes(toolFailure.structuredContent, ERROR_RESULT_SCHEMA), []);
  assert.strictEqual(JSON.parse(toolFailure.content[0].text).code, 'GATEWAY_UNREACHABLE');

  // Gateway non-2xx bodies become structured execution errors, never
  // successful results; stable rejection identifiers are preserved.
  assert.deepStrictEqual(unwrapGatewayResult({ status: 200, data: { ok: true } }), { ok: true });
  assert.strictEqual(unwrapGatewayResult('raw'), 'raw');
  assert.throws(
    () => unwrapGatewayResult({ status: 404, data: { error: 'Task not found' } }),
    error => error.code === 'STALE_IDENTITY' && error.retryable === false
      && /fresh identifier/.test(error.nextAction)
  );
  assert.throws(
    () => unwrapGatewayResult({
      status: 409,
      data: { error: 'active_conversation_mismatch', requestedConversationId: 'chat-1' }
    }),
    error => error.code === 'active_conversation_mismatch'
      && error.message === 'Gateway request failed with status 409'
  );
  assert.throws(
    () => unwrapGatewayResult({ status: 503, data: {} }),
    error => error.code === 'GATEWAY_UNAVAILABLE' && error.retryable === true
  );

  const gatewayFailure = asMcpError(
    (() => {
      try {
        unwrapGatewayResult({ status: 404, data: { error: 'Task not found' } });
      } catch (error) {
        return error;
      }
      return null;
    })()
  );
  assert.strictEqual(gatewayFailure.isError, true);
  assert.deepStrictEqual(checkTypes(gatewayFailure.structuredContent, ERROR_RESULT_SCHEMA), []);
  assert.strictEqual(JSON.parse(gatewayFailure.content[0].text).code, 'STALE_IDENTITY');

  // Queue-probe submissions are rejected as structured errors offline.
  const rejected = await callTool('traecn_send_message', { message: 'queue status' }, {
    host: '127.0.0.1', port: 1, token: '', timeout: 1000
  });
  assert.strictEqual(rejected.isError, true);
  const probePayload = JSON.parse(rejected.content[0].text);
  assert.strictEqual(probePayload.code, 'generic_queue_probe_task_rejected');
  assert.strictEqual(probePayload.retryable, false);
  assert.ok(probePayload.nextAction);

  // Text content stays semantically equivalent to structuredContent.
  const value = { taskId: 'task-1', status: 'accepted' };
  const ok = asMcpContent(value);
  assert.deepStrictEqual(JSON.parse(ok.content[0].text), ok.structuredContent);
  const failure = asMcpError(new Error('boom'));
  assert.deepStrictEqual(JSON.parse(failure.content[0].text), failure.structuredContent);

  console.log('[metadata-quality.test.js] PASS');
})().catch(error => {
  console.error('[metadata-quality.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
