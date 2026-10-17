'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { toolDefinitions, formatResult, PLUGIN_ID, register } = require('./index');
const { TraeCNApiClient } = require('../../src/client/traecnapi-client');
const { listCommands, mapSettingsAction } = require('../../src/client/command-set');
const { createRunner } = require('../../src/shared/test-runner');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'openclaw.plugin.json'), 'utf8'));

const r = createRunner('index.test.js');
const { test, asyncTest, summary } = r;

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

test('manifest declares every existing runtime tool for current OpenClaw hosts', () => {
  const names = toolDefinitions.map(tool => tool.name).sort();
  assert.deepStrictEqual(manifest.tools.map(tool => tool.name).sort(), names);
  assert.deepStrictEqual((manifest.contracts && manifest.contracts.tools || []).slice().sort(), names);
});

function registeredTools(pluginConfig = {}) {
  const tools = [];
  const originalLog = console.log;
  try {
    console.log = () => {};
    register({ pluginConfig, registerTool: tool => tools.push(tool) });
  } finally {
    console.log = originalLog;
  }
  return tools;
}

test('registration preserves legacy handlers and supplies the current execute contract', () => {
  assert.strictEqual(require('./index').default.register, register);
  const tools = registeredTools();
  assert.strictEqual(tools.length, toolDefinitions.length);
  for (let index = 0; index < tools.length; index++) {
    assert.strictEqual(tools[index].handler, toolDefinitions[index].handler);
    assert.strictEqual(typeof tools[index].execute, 'function', `${tools[index].name} missing execute`);
  }
});

test('required tools are present', () => {
  const names = toolDefinitions.map(t => t.name);
  assert.ok(names.includes('traecn_capabilities'), 'Missing traecn_capabilities');
  assert.ok(names.includes('traecn_preflight'), 'Missing traecn_preflight');
  assert.ok(names.includes('traecn_plan_operation'), 'Missing traecn_plan_operation');
  assert.ok(names.includes('traecn_command_set'), 'Missing traecn_command_set');
  assert.ok(names.includes('traecn_command'), 'Missing traecn_command');
  assert.ok(names.includes('traecn_vibe_workflow'), 'Missing traecn_vibe_workflow');
  assert.ok(names.includes('traecn_status'), 'Missing traecn_status');
  assert.ok(names.includes('traecn_delegate'), 'Missing traecn_delegate');
  assert.ok(names.includes('traecn_new_chat'), 'Missing traecn_new_chat');
  assert.ok(names.includes('traecn_switch_mode'), 'Missing traecn_switch_mode');
  assert.ok(names.includes('traecn_switch_model'), 'Missing traecn_switch_model');
  assert.ok(names.includes('traecn_queue_status'), 'Missing traecn_queue_status');
  assert.ok(names.includes('traecn_cleanup_queue'), 'Missing traecn_cleanup_queue');
  assert.ok(names.includes('traecn_cleanup_watch_status'), 'Missing traecn_cleanup_watch_status');
  assert.ok(names.includes('traecn_long_queue_proof_start'), 'Missing traecn_long_queue_proof_start');
  assert.ok(names.includes('traecn_long_queue_proof_status'), 'Missing traecn_long_queue_proof_status');
  assert.ok(names.includes('traecn_long_queue_proof_cancel'), 'Missing traecn_long_queue_proof_cancel');
  assert.ok(names.includes('traecn_chat'), 'Missing traecn_chat');
  assert.ok(names.includes('traecn_open_project'), 'Missing traecn_open_project');
});

test('traecn_open_project exposes newInstance in runtime and manifest schemas', () => {
  const runtimeTool = toolDefinitions.find(tool => tool.name === 'traecn_open_project');
  const manifestTool = manifest.tools.find(tool => tool.name === 'traecn_open_project');

  assert.deepStrictEqual(runtimeTool.parameters.properties.newInstance, {
    type: 'boolean',
    description: 'Open the project in a separate TraeCN window when TraeCN is already running'
  });
  assert.deepStrictEqual(manifestTool.parameters.properties.newInstance, {
    type: 'boolean',
    description: 'Open the project in a separate TraeCN window when TraeCN is already running'
  });
});

test('preset command set includes core control commands', () => {
  const commands = listCommands().map(definition => definition.command);
  assert.ok(commands.includes('capabilities'));
  assert.ok(commands.includes('preflight'));
  assert.ok(commands.includes('confirm_plan'));
  assert.ok(commands.includes('restart_trae_debug'));
  assert.ok(commands.includes('delegate'));
  assert.ok(commands.includes('adopt_current_task'));
  assert.ok(commands.includes('stop_generation'));
  assert.ok(commands.includes('cleanup_foreign_solo_queue'));
  assert.ok(commands.includes('cleanup_queue_watch_status'));
  assert.ok(commands.includes('review_gate_status'));
  assert.ok(commands.includes('resolve_review_gate'));
  assert.ok(commands.includes('switch_model'));
  assert.ok(commands.includes('settings_set'));
  assert.ok(commands.includes('approve_dialog'));
  assert.ok(commands.includes('batch_submit'));
  assert.ok(commands.includes('review_code'));
  assert.ok(commands.includes('vibe_workflow'));
  assert.ok(commands.includes('long_queue_proof_start'));
  assert.ok(commands.includes('long_queue_proof_status'));
  assert.ok(commands.includes('long_queue_proof_cancel'));
});

test('traecn_command enum stays aligned with preset command set', () => {
  const commandTool = toolDefinitions.find(t => t.name === 'traecn_command');
  const commandEnum = commandTool.parameters.properties.command.enum;
  assert.deepStrictEqual(commandEnum, listCommands().map(definition => definition.command));
});

test('manifest traecn_command enum stays aligned with preset command set', () => {
  const commandTool = manifest.tools.find(t => t.name === 'traecn_command');
  const commandEnum = commandTool.parameters.properties.command.enum;
  assert.deepStrictEqual(commandEnum, listCommands().map(definition => definition.command));
});

test('manifest exposes direct unattended vibe workflow tool', () => {
  const runtimeTool = toolDefinitions.find(t => t.name === 'traecn_vibe_workflow');
  const manifestTool = manifest.tools.find(t => t.name === 'traecn_vibe_workflow');
  assert.ok(runtimeTool, 'runtime vibe workflow tool missing');
  assert.ok(manifestTool, 'manifest vibe workflow tool missing');
  assert.ok(runtimeTool.parameters.required.includes('task'));
  assert.ok(manifestTool.parameters.required.includes('task'));
  assert.ok(runtimeTool.parameters.properties.steps);
  assert.ok(runtimeTool.parameters.properties.followupTasks);
  assert.ok(runtimeTool.parameters.properties.completionChecks);
  assert.ok(runtimeTool.parameters.properties.fallbackModels);
  assert.ok(runtimeTool.parameters.properties.sessionId);
  assert.ok(runtimeTool.parameters.properties.soloChat);
  assert.ok(runtimeTool.parameters.properties.soloChatTitleIncludes);
  assert.ok(runtimeTool.parameters.properties.forceBackground);
  assert.ok(runtimeTool.parameters.properties.queueMaxWaitMs);
  assert.ok(manifestTool.parameters.properties.steps);
  assert.ok(manifestTool.parameters.properties.followupTasks);
  assert.ok(manifestTool.parameters.properties.completionChecks);
  assert.ok(manifestTool.parameters.properties.fallbackModels);
  assert.ok(manifestTool.parameters.properties.sessionId);
  assert.ok(manifestTool.parameters.properties.soloChat);
  assert.ok(manifestTool.parameters.properties.soloChatTitleIncludes);
  assert.ok(manifestTool.parameters.properties.forceBackground);
  assert.ok(manifestTool.parameters.properties.queueMaxWaitMs);
});

test('mapSettingsAction routes to implemented settings commands', () => {
  assert.deepStrictEqual(mapSettingsAction('navigate', { section: 'MCP' }), {
    command: 'settings_navigate',
    params: { section: 'MCP' }
  });
  assert.deepStrictEqual(mapSettingsAction('readTables'), {
    command: 'settings_read_all',
    params: {}
  });
});

test('manifest and runtime expose direct settings tools', () => {
  for (const toolName of ['traecn_settings_action', 'traecn_settings_read', 'traecn_settings_set']) {
    const runtimeTool = toolDefinitions.find(t => t.name === toolName);
    const manifestTool = manifest.tools.find(t => t.name === toolName);
    assert.ok(runtimeTool, `Missing runtime tool ${toolName}`);
    assert.ok(manifestTool, `Missing manifest tool ${toolName}`);
    assert.deepStrictEqual(manifestTool.parameters.required || [], runtimeTool.parameters.required || []);
    for (const propertyName of Object.keys(runtimeTool.parameters.properties || {})) {
      assert.ok(manifestTool.parameters.properties[propertyName], `${toolName} missing manifest property ${propertyName}`);
    }
  }
});

test('manifest and runtime expose direct long-queue proof tools with quota guard', () => {
  for (const toolName of ['traecn_long_queue_proof_start', 'traecn_long_queue_proof_status', 'traecn_long_queue_proof_cancel']) {
    const runtimeTool = toolDefinitions.find(t => t.name === toolName);
    const manifestTool = manifest.tools.find(t => t.name === toolName);
    assert.ok(runtimeTool, `Missing runtime tool ${toolName}`);
    assert.ok(manifestTool, `Missing manifest tool ${toolName}`);
    assert.deepStrictEqual(manifestTool.parameters.required || [], runtimeTool.parameters.required || []);
    for (const propertyName of Object.keys(runtimeTool.parameters.properties || {})) {
      assert.ok(manifestTool.parameters.properties[propertyName], `${toolName} missing manifest property ${propertyName}`);
    }
  }
  const runtimeStart = toolDefinitions.find(t => t.name === 'traecn_long_queue_proof_start');
  const manifestStart = manifest.tools.find(t => t.name === 'traecn_long_queue_proof_start');
  assert.ok(runtimeStart.parameters.properties.allowQuotaSpend);
  assert.ok(manifestStart.parameters.properties.allowQuotaSpend);
  assert.ok(runtimeStart.description.includes('allowQuotaSpend'));
  assert.ok(manifestStart.description.includes('allowQuotaSpend'));
});

test('traecn_delegate has required task parameter', () => {
  const delegate = toolDefinitions.find(t => t.name === 'traecn_delegate');
  assert.ok(delegate.parameters.required.includes('task'));
  assert.ok(delegate.parameters.properties.task);
  assert.ok(delegate.parameters.properties.projectPath);
  assert.ok(delegate.parameters.properties.sessionId);
  assert.ok(delegate.parameters.properties.chatId);
  assert.ok(delegate.parameters.properties.soloChat);
  assert.ok(delegate.parameters.properties.soloChatTitleIncludes);
  assert.ok(delegate.parameters.properties.newChat);
  assert.ok(delegate.parameters.properties.waitForQueue);
  assert.ok(delegate.parameters.properties.asyncPoll);
  assert.ok(delegate.parameters.properties.background);
  assert.ok(delegate.parameters.properties.forceBackground);
  assert.ok(delegate.parameters.properties.reviewRequired);
  assert.ok(delegate.parameters.properties.autoContinue);
  assert.ok(delegate.parameters.properties.followupTasks);
  assert.ok(delegate.parameters.properties.completionChecks);
  assert.ok(delegate.parameters.properties.notifyUrl);
  assert.ok(delegate.parameters.properties.fallbackModels);
  assert.ok(delegate.parameters.properties.autoModelFallback);
  assert.ok(delegate.parameters.properties.modelProbeIntervalMs);
  assert.ok(delegate.parameters.properties.maxQueueWaitMs);
  assert.ok(delegate.parameters.properties.queueMaxWaitMs);
});

test('manifest traecn_delegate exposes async workflow and queue options', () => {
  const delegate = manifest.tools.find(t => t.name === 'traecn_delegate');
  assert.ok(delegate.parameters.required.includes('task'));
  assert.ok(delegate.parameters.properties.projectPath);
  assert.ok(delegate.parameters.properties.sessionId);
  assert.ok(delegate.parameters.properties.chatId);
  assert.ok(delegate.parameters.properties.soloChat);
  assert.ok(delegate.parameters.properties.soloChatTitleIncludes);
  assert.ok(delegate.parameters.properties.newChat);
  assert.ok(delegate.parameters.properties.waitForQueue);
  assert.ok(delegate.parameters.properties.asyncPoll);
  assert.ok(delegate.parameters.properties.background);
  assert.ok(delegate.parameters.properties.forceBackground);
  assert.ok(delegate.parameters.properties.reviewRequired);
  assert.ok(delegate.parameters.properties.autoContinue);
  assert.ok(delegate.parameters.properties.followupTasks);
  assert.ok(delegate.parameters.properties.completionChecks);
  assert.ok(delegate.parameters.properties.notifyUrl);
  assert.ok(delegate.parameters.properties.fallbackModels);
  assert.ok(delegate.parameters.properties.autoModelFallback);
  assert.ok(delegate.parameters.properties.modelProbeIntervalMs);
  assert.ok(delegate.parameters.properties.maxQueueWaitMs);
  assert.ok(delegate.parameters.properties.queueMaxWaitMs);
});

test('manifest and runtime expose cleanup queue tool', () => {
  const runtimeTool = toolDefinitions.find(t => t.name === 'traecn_cleanup_queue');
  const manifestTool = manifest.tools.find(t => t.name === 'traecn_cleanup_queue');
  assert.ok(runtimeTool);
  assert.ok(manifestTool);
  assert.ok(runtimeTool.parameters.properties.dryRun);
  assert.ok(runtimeTool.parameters.properties.execute);
  assert.ok(runtimeTool.parameters.properties.maxPasses);
  assert.ok(runtimeTool.parameters.properties.settleMs);
  assert.ok(manifestTool.parameters.properties.dryRun);
  assert.ok(manifestTool.parameters.properties.execute);
  assert.ok(manifestTool.parameters.properties.maxPasses);
  assert.ok(manifestTool.parameters.properties.settleMs);
});

test('traecn_switch_model has required model parameter', () => {
  const switchModel = toolDefinitions.find(t => t.name === 'traecn_switch_model');
  assert.ok(switchModel.parameters.required.includes('model'));
  assert.ok(switchModel.parameters.properties.waitForQueue);
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

async function runExecutionTests() {
  await asyncTest('native execute returns tool errors without losing the error envelope', async () => {
    const original = TraeCNApiClient.prototype.getStatus;
    try {
      TraeCNApiClient.prototype.getStatus = async () => { throw new Error('Owned gateway unavailable'); };
      const status = registeredTools().find(tool => tool.name === 'traecn_status');
      assert.deepStrictEqual(await status.execute('failed-call', {}), {
        content: [{ type: 'text', text: '[TraeCN Error] Owned gateway unavailable' }],
        isError: true
      });
    } finally {
      TraeCNApiClient.prototype.getStatus = original;
    }
  });

  await asyncTest('pre-aborted native calls reject before contacting the gateway', async () => {
    const original = TraeCNApiClient.prototype.getStatus;
    let calls = 0;
    try {
      TraeCNApiClient.prototype.getStatus = async () => { calls++; return { data: {} }; };
      const status = registeredTools().find(tool => tool.name === 'traecn_status');
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(status.execute('cancelled-call', {}, controller.signal), { name: 'AbortError' });
      assert.strictEqual(calls, 0);
    } finally {
      TraeCNApiClient.prototype.getStatus = original;
    }
  });

  await asyncTest('execute wraps the legacy payload in native text content and details', async () => {
    const commandSet = registeredTools().find(tool => tool.name === 'traecn_command_set');
    const legacy = await commandSet.handler({}, {});
    const result = await commandSet.execute('offline-call', {});
    assert.deepStrictEqual(result.details, legacy);
    assert.deepStrictEqual(result.content, [{ type: 'text', text: JSON.stringify(legacy, null, 2) }]);
  });

  await asyncTest('execute uses the configured gateway origin and token while handler keeps its context', async () => {
    const original = TraeCNApiClient.prototype.getStatus;
    const connections = [];
    try {
      TraeCNApiClient.prototype.getStatus = async function(allowAutoStart) {
        connections.push({ host: this.host, port: this.port, token: this.token, allowAutoStart });
        return { status: 200, data: { connected: true } };
      };
      const status = registeredTools({ baseUrl: 'http://localhost:54321/', token: 'test-only-token' })
        .find(tool => tool.name === 'traecn_status');
      const result = await status.execute('configured-call', { allowAutoStart: false });
      assert.deepStrictEqual(connections[0], {
        host: 'localhost', port: 54321, token: 'test-only-token', allowAutoStart: false
      });
      assert.deepStrictEqual(JSON.parse(result.content[0].text), result.details);
      await status.handler({ allowAutoStart: false }, { host: 'legacy-host', port: 12345, token: 'legacy-token' });
      assert.deepStrictEqual(connections[1], {
        host: 'legacy-host', port: 12345, token: 'legacy-token', allowAutoStart: false
      });
    } finally {
      TraeCNApiClient.prototype.getStatus = original;
    }
  });

  await asyncTest('invalid gateway origins fail before registering executable tools', async () => {
    for (const baseUrl of ['not-a-url', 'https://localhost:54321', 'http://localhost:54321/api',
      'http://user:password@localhost:54321', 'http://localhost:54321?token=test']) {
      assert.throws(() => registeredTools({ baseUrl }), /baseUrl/);
    }
  });

  await asyncTest('delegate forwards completion checks through the asynchronous gateway path', async () => {
    const originalAsync = TraeCNApiClient.prototype.delegateAsync;
    const originalRequest = TraeCNApiClient.prototype._request;
    const calls = [];
    const completionChecks = {
      requiredFiles: ['owned-fixture.txt'],
      requiredText: [{ filePath: 'owned-fixture.txt', includes: ['COMPLETE', 'owned-marker'] }]
    };
    try {
      TraeCNApiClient.prototype._request = () => { throw new Error('Network forbidden in offline regression'); };
      TraeCNApiClient.prototype.delegateAsync = async function(task, options) {
        calls.push({ task, options, host: this.host, port: this.port });
        return { data: { taskId: 'offline-owned-task', status: 'queued' } };
      };
      const delegate = registeredTools({ baseUrl: 'http://localhost:54321' })
        .find(tool => tool.name === 'traecn_delegate');
      const params = { task: 'Verify the owned fixture', completionChecks };
      const legacyResult = await delegate.handler(params, {});
      assert.deepStrictEqual(calls[0].options.completionChecks, completionChecks);
      const nativeResult = await delegate.execute('completion-check-call', params);
      assert.strictEqual(calls.length, 2);
      for (const call of calls) assert.deepStrictEqual(call.options.completionChecks, completionChecks);
      assert.strictEqual(calls[1].port, 54321);
      assert.deepStrictEqual(nativeResult.details, legacyResult);
    } finally {
      TraeCNApiClient.prototype.delegateAsync = originalAsync;
      TraeCNApiClient.prototype._request = originalRequest;
    }
  });

  summary();
  process.exitCode = r.failed > 0 ? 1 : 0;
}

runExecutionTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
