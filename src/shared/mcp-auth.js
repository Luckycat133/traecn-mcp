'use strict';

/**
 * MCP tool authorization.
 *
 * Each tool is tagged with the minimum permission a caller must hold. The
 * The compact MCP surface maps directly to read, write, or delegated work.
 *
 * Permission ladder (cumulative; admin implies everything):
 *   read       – read-only discovery: capabilities, status, settings reads,
 *                queue/dialog introspection.
 *   write      – mutate non-task state: switch model/mode, manage dialogs.
 *   delegate   – run or queue TraeCN tasks, open projects, approve dialogs
 *                that gate side effects.
 *   admin      – reserved for key rotation, role changes, and similar ops.
 */

const READ_PERMISSION = 'read';
const WRITE_PERMISSION = 'write';
const DELEGATE_PERMISSION = 'delegate';
const ADMIN_PERMISSION = 'admin';

const PERMISSION_LEVELS = [READ_PERMISSION, WRITE_PERMISSION, DELEGATE_PERMISSION, ADMIN_PERMISSION];

// Map of tool name -> minimum permission required.
const TOOL_PERMISSIONS = Object.freeze({
  traecn_send_message: DELEGATE_PERMISSION,
  traecn_get_task: READ_PERMISSION,
  traecn_cancel_task: DELEGATE_PERMISSION,
  traecn_stop_generation: DELEGATE_PERMISSION,
  traecn_open_workspace: DELEGATE_PERMISSION,
  traecn_list_models: READ_PERMISSION,
  traecn_select_model: WRITE_PERMISSION,
  traecn_select_mode: WRITE_PERMISSION,
  traecn_list_setting_sections: READ_PERMISSION,
  traecn_list_settings: READ_PERMISSION,
  traecn_list_setting_options: READ_PERMISSION,
  traecn_set_setting_toggle: WRITE_PERMISSION,
  traecn_select_setting_option: WRITE_PERMISSION,
  traecn_set_setting_text: WRITE_PERMISSION,
  traecn_list_conversations: READ_PERMISSION,
  traecn_create_conversation: WRITE_PERMISSION,
  traecn_select_conversation: WRITE_PERMISSION,
  traecn_delete_conversation: DELEGATE_PERMISSION,
  traecn_answer_question: DELEGATE_PERMISSION,
  traecn_decide_approval: DELEGATE_PERMISSION
});

function requiredPermissionFor(toolName, args = {}) {
  void args;
  return TOOL_PERMISSIONS[toolName] || READ_PERMISSION;
}

function hasPermission(apiKeyManager, keyId, required) {
  if (!apiKeyManager || !keyId) return false;
  if (typeof apiKeyManager.hasPermission !== 'function') return false;
  return apiKeyManager.hasPermission(keyId, required);
}

/**
 * Authorize a tool call.
 *
 * When apiKeyManager is null/disabled, the call is allowed (the MCP server is
 * considered trusted in single-user setups). When enabled, the active keyId
 * must hold the required permission.
 *
 * @returns {{ok: true} | {ok: false, code: string, message: string, required: string}}
 */
function authorizeTool({ apiKeyManager, keyId, toolName, args }) {
  if (!apiKeyManager || apiKeyManager.enabled !== true) {
    return { ok: true, reason: 'auth-disabled' };
  }
  if (!keyId || typeof keyId !== 'string') {
    return {
      ok: false,
      code: 'MCP_AUTH_REQUIRED',
      message: 'Tool call requires an authenticated API key',
      required: requiredPermissionFor(toolName, args)
    };
  }
  const required = requiredPermissionFor(toolName, args);
  if (!hasPermission(apiKeyManager, keyId, required)) {
    return {
      ok: false,
      code: 'MCP_AUTH_DENIED',
      message: `API key ${keyId} lacks permission '${required}' required by tool '${toolName}'`,
      required
    };
  }
  return { ok: true, reason: 'permission-granted', keyId, required };
}

function assertValidPermission(permission) {
  return PERMISSION_LEVELS.includes(permission);
}

module.exports = {
  READ_PERMISSION,
  WRITE_PERMISSION,
  DELEGATE_PERMISSION,
  ADMIN_PERMISSION,
  PERMISSION_LEVELS,
  TOOL_PERMISSIONS,
  requiredPermissionFor,
  authorizeTool,
  hasPermission,
  assertValidPermission
};
