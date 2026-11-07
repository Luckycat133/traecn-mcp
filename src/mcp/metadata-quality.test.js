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
const http = require('http');
const { fromJsonSchema } = require('@modelcontextprotocol/client');
const { TaskOrchestrator } = require('../http/task-orchestrator');
const { TraeCNAutomationError } = require('../cdp/errors');
const { errorToBody } = require('../http/error-mapping');
const { MCP_CONTRACT_VERSION, MCP_TOOL_NAMES } = require('./contract');
const { MCP_TOOLS, TOOL_TITLES, TOOL_TASK_SUPPORT } = require('./tool-metadata');
const { TOOL_OUTPUT_SCHEMAS, ERROR_RESULT_SCHEMA } = require('./output-schemas');
const { asMcpContent, asMcpError, describeToolExecutionError, unwrapGatewayResult } = require('./tools');
const { callTool } = require('../../mcp-server');

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
    elapsed: 4200, completedAt: new Date(1755800004200).toISOString(), message: '完成', fromHistory: true,
    metadata: {}, stepCount: 3, result: { text: 'done', stable: true },
    detailLevel: 'result'
  },
  traecn_cancel_task: { taskId: 'task-1', status: 'cancelled', stopResult: { success: true } },
  traecn_stop_generation: { success: true, conversationId: 'chat-1', scope: 'active_solo_conversation' },
  traecn_open_workspace: {
    success: true, projectPath: '/tmp/demo', verifiedWorkspace: { folderName: 'demo', rootPath: null },
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

  // Completed history records retain ISO timestamps; active/legacy records
  // may expose epoch milliseconds or no completion time. Use the official
  // client's actual schema validator, including its date-time checks.
  const taskOutput = fromJsonSchema(TOOL_OUTPUT_SCHEMAS.traecn_get_task)['~standard'];
  for (const completedAt of ['2026-10-02T16:31:44.993Z', 1790958704993, 0, null]) {
    const result = await taskOutput.validate({ ...REPRESENTATIVE_RESULTS.traecn_get_task, completedAt });
    assert.strictEqual(result.issues, undefined, `valid completion timestamp rejected: ${JSON.stringify(result.issues)}`);
  }
  for (const completedAt of [true, {}, [], '', 'not-a-date', '2026-02-31T16:31:44.993Z']) {
    const result = await taskOutput.validate({ completedAt });
    assert.ok(result.issues?.length, 'malformed completion timestamp must not validate');
  }

  const workspaceSchema = TOOL_OUTPUT_SCHEMAS.traecn_open_workspace;
  for (const verifiedWorkspace of [
    { folderName: 'demo', rootPath: '/tmp/demo' },
    { folderName: 'demo', rootPath: null },
    '/tmp/demo'
  ]) {
    assert.deepStrictEqual(checkTypes({ verifiedWorkspace }, workspaceSchema), [],
      'workspace output must preserve detected identity and compatible path results');
  }
  for (const verifiedWorkspace of [
    false, [], { folderName: 123, rootPath: null }, { folderName: 'demo', rootPath: false }
  ]) {
    assert.ok(checkTypes({ verifiedWorkspace }, workspaceSchema).length > 0,
      'workspace verification must reject malformed identity fields');
  }

  // A repeated submission can return the original terminal answer rather
  // than a fresh acceptance. Exercise owner-produced payloads through the
  // real MCP HTTP client so output metadata covers this existing behavior.
  const terminalStates = ['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected'];
  let terminalPayload;
  const replayServer = http.createServer((req, res) => {
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/api/tasks/submit');
    assert.strictEqual(req.headers['idempotency-key'], 'metadata-replay-key');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(terminalPayload));
  });
  await new Promise(resolve => replayServer.listen(0, '127.0.0.1', resolve));
  try {
    for (const status of terminalStates) {
      const task = {
        taskId: 'original-task', idempotencyKey: 'metadata-replay-key', status,
        result: status === 'done' ? { text: 'original terminal answer', stable: true } : null,
        error: ['error', 'queue_timeout'].includes(status) ? 'original error' : null
      };
      const orchestrator = new TaskOrchestrator({
        taskQueue: new Map([[task.taskId, task]]),
        isTerminalStatus: candidate => terminalStates.includes(candidate)
      });
      const { statusCode, ...data } = orchestrator.resolveIdempotentTask(task.idempotencyKey);
      assert.strictEqual(statusCode, 200);
      terminalPayload = data;
      const result = await callTool('traecn_send_message', { message: 'repeat authorized work' }, {
        host: '127.0.0.1', port: replayServer.address().port, token: '', timeout: 1000
      }, { idempotencyKey: task.idempotencyKey });
      assert.deepStrictEqual(result.structuredContent, data);
      assert.deepStrictEqual(JSON.parse(result.content[0].text), data);
      assert.deepStrictEqual(checkTypes(data, TOOL_OUTPUT_SCHEMAS.traecn_send_message), [],
        `${status} terminal replay violates send-message output metadata`);
    }
  } finally { await new Promise(resolve => replayServer.close(resolve)); }

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

  // Explicit stable codes take precedence over the legacy error token.
  assert.throws(
    () => unwrapGatewayResult({ status: 409, data: { code: 'WINDOW_NOT_VISIBLE', error: 'legacy_identifier' } }),
    error => error.code === 'WINDOW_NOT_VISIBLE' && /unlock/i.test(error.nextAction)
  );
  for (const code of [false, {}, '', 'bad-code', 'malformed code', 'A'.repeat(65)]) {
    assert.throws(
      () => unwrapGatewayResult({ status: 409, data: { code, error: 'active_conversation_mismatch' } }),
      error => error.code === 'active_conversation_mismatch',
      'malformed explicit code must preserve the legacy error-token fallback'
    );
  }
  for (const code of ['active_conversation_mismatch', 'constructor']) {
    assert.throws(
      () => unwrapGatewayResult({ status: 409, data: { code, error: 'human-readable failure' } }),
      error => error.code === code && error.retryable === false && typeof error.nextAction === 'string'
    );
  }

  // Replay the owner's actual hidden-renderer HTTP body through the real
  // MCP HTTP adapter. It is a blocked UI operation, even on the old 502
  // mapping, and cannot advise resubmitting already accepted task work.
  const windowBody = errorToBody(TraeCNAutomationError.windowNotVisible('renderer stayed hidden after application activation'));
  let windowStatus = 409;
  let windowRequests = 0;
  const windowServer = http.createServer((req, res) => {
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/api/conversations/manage');
    windowRequests++;
    req.resume();
    res.writeHead(windowStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(windowBody));
  });
  await new Promise(resolve => windowServer.listen(0, '127.0.0.1', resolve));
  try {
    for (const status of [409, 502]) {
      windowStatus = status;
      let failure;
      try {
        await callTool('traecn_create_conversation', {}, {
          host: '127.0.0.1', port: windowServer.address().port, token: '', timeout: 1000
        });
      } catch (error) { failure = error; }
      assert.ok(failure, 'blocked UI responses must reject the HTTP adapter call');
      const result = asMcpError(failure);
      const detail = result.structuredContent;
      assert.strictEqual(result.isError, true);
      assert.strictEqual(detail.code, 'WINDOW_NOT_VISIBLE');
      assert.strictEqual(detail.message, windowBody.error);
      assert.match(detail.nextAction, /unlock/i);
      assert.match(detail.nextAction, /visible/i);
      assert.match(detail.nextAction, /taskId/);
      assert.doesNotMatch(detail.nextAction, /doctor/);
      assert.deepStrictEqual(JSON.parse(result.content[0].text), detail);
      assert.strictEqual((await fromJsonSchema(ERROR_RESULT_SCHEMA)['~standard'].validate(detail)).issues, undefined);
      assert.strictEqual((await fromJsonSchema(TOOL_OUTPUT_SCHEMAS.traecn_create_conversation)['~standard'].validate(detail)).issues, undefined);
    }
    assert.strictEqual(windowRequests, 2, 'each blocked UI call must make exactly one HTTP attempt');
  } finally { await new Promise(resolve => windowServer.close(resolve)); }

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

  // Authorization is a real execution-error path too; its single required
  // scope must agree with the error schema and retain text/structured parity.
  for (const keyId of [undefined, 'reader']) {
    const denied = await callTool('traecn_create_conversation', {}, {}, {
      apiKeyManager: { enabled: true, hasPermission: () => false }, keyId
    });
    assert.strictEqual(denied.isError, true);
    assert.deepStrictEqual(checkTypes(denied.structuredContent, ERROR_RESULT_SCHEMA), []);
    assert.deepStrictEqual(JSON.parse(denied.content[0].text), denied.structuredContent);
    assert.strictEqual(denied.structuredContent.required, 'write');
    assert.strictEqual(denied.structuredContent.retryable, false);
    assert.ok(denied.structuredContent.nextAction);
  }

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
