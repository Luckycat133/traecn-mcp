'use strict';

const assert = require('assert');
const mcpAuth = require('./mcp-auth');
const { ApiKeyManager } = require('./api-key-manager');
const { createRunner } = require('./test-runner');
const runner = createRunner('mcp-auth.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

// ApiKeyManager reads TRAECN_API_KEYS_ENABLED from the environment, so the
// tests that need an enabled manager must flip the env var first.
process.env.TRAECN_API_KEYS_ENABLED = '1';

console.log('\n[mcp-auth.test.js] Running tests...\n');

test('requiredPermissionFor returns read for read-only tools', () => {
  assert.strictEqual(mcpAuth.requiredPermissionFor('check_status'), 'read');
  assert.strictEqual(mcpAuth.requiredPermissionFor('check_queue'), 'read');
  assert.strictEqual(mcpAuth.requiredPermissionFor('get_settings'), 'read');
  assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_capabilities'), 'read');
  assert.strictEqual(mcpAuth.requiredPermissionFor('wait_task'), 'read');
  assert.strictEqual(mcpAuth.requiredPermissionFor('wait_task', { autoApproveDialog: 'auto' }), 'delegate');
});

test('requiredPermissionFor returns write for state-changing non-task tools', () => {
  assert.strictEqual(mcpAuth.requiredPermissionFor('switch_model'), 'write');
  assert.strictEqual(mcpAuth.requiredPermissionFor('switch_mode'), 'write');
  assert.strictEqual(mcpAuth.requiredPermissionFor('new_chat'), 'write');
});

test('requiredPermissionFor returns delegate for task-running tools', () => {
  assert.strictEqual(mcpAuth.requiredPermissionFor('run_task'), 'delegate');
  assert.strictEqual(mcpAuth.requiredPermissionFor('queue_task'), 'delegate');
  assert.strictEqual(mcpAuth.requiredPermissionFor('review_code'), 'delegate');
  assert.strictEqual(mcpAuth.requiredPermissionFor('open_project'), 'delegate');
  assert.strictEqual(mcpAuth.requiredPermissionFor('approve_dialog'), 'delegate');
});

test('requiredPermissionFor returns admin for set_setting', () => {
  assert.strictEqual(mcpAuth.requiredPermissionFor('set_setting'), 'admin');
});

test('resolveCommandPermission treats read-prefixed commands as read', () => {
  assert.strictEqual(mcpAuth.resolveCommandPermission('get_settings'), 'read');
  assert.strictEqual(mcpAuth.resolveCommandPermission('list_sessions'), 'read');
  assert.strictEqual(mcpAuth.resolveCommandPermission('check_status'), 'read');
  assert.strictEqual(mcpAuth.resolveCommandPermission('read_history'), 'read');
});

test('resolveCommandPermission defaults to delegate for unknown commands', () => {
  assert.strictEqual(mcpAuth.resolveCommandPermission('approve_dialog'), 'delegate');
  assert.strictEqual(mcpAuth.resolveCommandPermission('open_project'), 'delegate');
});

test('requiredPermissionFor on traecn_command infers from the command argument', () => {
  assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_command', { command: 'check_status' }), 'read');
  assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_command', { command: 'wait_task' }), 'read');
  assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_command', {
    command: 'wait_task',
    params: { autoApproveDialog: 'auto' }
  }), 'delegate');
  assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_command', { command: 'approve_dialog' }), 'delegate');
});

test('authorizeTool allows all calls when auth layer is disabled', () => {
  const decision = mcpAuth.authorizeTool({
    apiKeyManager: { enabled: false },
    keyId: null,
    toolName: 'run_task',
    args: {}
  });
  assert.strictEqual(decision.ok, true);
  assert.strictEqual(decision.reason, 'auth-disabled');
});

test('authorizeTool allows all calls when apiKeyManager is null', () => {
  const decision = mcpAuth.authorizeTool({
    apiKeyManager: null,
    keyId: null,
    toolName: 'run_task',
    args: {}
  });
  assert.strictEqual(decision.ok, true);
});

test('authorizeTool rejects missing keyId when auth is enabled', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const decision = mcpAuth.authorizeTool({
    apiKeyManager: manager,
    keyId: null,
    toolName: 'run_task',
    args: {}
  });
  assert.strictEqual(decision.ok, false);
  assert.strictEqual(decision.code, 'MCP_AUTH_REQUIRED');
  assert.strictEqual(decision.required, 'delegate');
});

test('authorizeTool rejects when key lacks the required permission', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
  const decision = mcpAuth.authorizeTool({
    apiKeyManager: manager,
    keyId,
    toolName: 'run_task',
    args: {}
  });
  assert.strictEqual(decision.ok, false);
  assert.strictEqual(decision.code, 'MCP_AUTH_DENIED');
  assert.strictEqual(decision.required, 'delegate');
});

test('authorizeTool accepts read key on read tool', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
  const decision = mcpAuth.authorizeTool({
    apiKeyManager: manager,
    keyId,
    toolName: 'check_status',
    args: {}
  });
  assert.strictEqual(decision.ok, true);
  assert.strictEqual(decision.reason, 'permission-granted');
  assert.strictEqual(decision.required, 'read');
});

test('authorizeTool accepts admin key on any tool', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { keyId } = manager.createKey({ name: 'root', permissions: ['admin'] });
  for (const tool of ['check_status', 'switch_model', 'run_task', 'set_setting']) {
    const decision = mcpAuth.authorizeTool({
      apiKeyManager: manager,
      keyId,
      toolName: tool,
      args: {}
    });
    assert.strictEqual(decision.ok, true, `admin should pass ${tool}`);
  }
});

test('authorizeTool resolves traecn_command permission from arguments', () => {
  const manager = new ApiKeyManager({ enabled: true });
  const { keyId } = manager.createKey({ name: 'writer', permissions: ['read', 'write'] });
  // read+write is enough for a read-prefixed command (and write commands).
  const ok = mcpAuth.authorizeTool({
    apiKeyManager: manager,
    keyId,
    toolName: 'traecn_command',
    args: { command: 'check_status' }
  });
  assert.strictEqual(ok.ok, true);

  // read+write is not enough for a delegate command.
  const denied = mcpAuth.authorizeTool({
    apiKeyManager: manager,
    keyId,
    toolName: 'traecn_command',
    args: { command: 'open_project' }
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'MCP_AUTH_DENIED');
  assert.strictEqual(denied.required, 'delegate');
});

test('assertValidPermission recognizes known permission levels', () => {
  assert.strictEqual(mcpAuth.assertValidPermission('read'), true);
  assert.strictEqual(mcpAuth.assertValidPermission('write'), true);
  assert.strictEqual(mcpAuth.assertValidPermission('delegate'), true);
  assert.strictEqual(mcpAuth.assertValidPermission('admin'), true);
  assert.strictEqual(mcpAuth.assertValidPermission('superuser'), false);
  assert.strictEqual(mcpAuth.assertValidPermission(''), false);
});

summary();
if (runner.failed > 0) process.exit(1);
