'use strict';

const assert = require('assert');
const mcpAuth = require('./mcp-auth');
const { ApiKeyManager } = require('./api-key-manager');

process.env.TRAECN_API_KEYS_ENABLED = '1';

assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_get_task'), 'read');
assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_list_conversations'), 'read');
assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_create_conversation'), 'write');
assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_select_model'), 'write');
assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_send_message'), 'delegate');
assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_cancel_task'), 'delegate');
assert.strictEqual(mcpAuth.requiredPermissionFor('traecn_answer_question'), 'delegate');

const manager = new ApiKeyManager({ enabled: true });
const { keyId } = manager.createKey({ name: 'reader', permissions: ['read'] });
assert.strictEqual(mcpAuth.authorizeTool({ apiKeyManager: manager, keyId, toolName: 'traecn_get_task', args: {} }).ok, true);
assert.strictEqual(mcpAuth.authorizeTool({ apiKeyManager: manager, keyId, toolName: 'traecn_send_message', args: {} }).ok, false);
assert.strictEqual(mcpAuth.authorizeTool({ apiKeyManager: null, keyId: null, toolName: 'traecn_send_message', args: {} }).ok, true);

for (const permission of ['read', 'write', 'delegate', 'admin']) {
  assert.strictEqual(mcpAuth.assertValidPermission(permission), true);
}
assert.strictEqual(mcpAuth.assertValidPermission('superuser'), false);

console.log('[mcp-auth.test.js] PASS');
