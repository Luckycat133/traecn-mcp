'use strict';

/**
 * MCP tool authorization.
 *
 * Each tool is tagged with the minimum permission a caller must hold. The
 * optional `traecn_command` tool requires a special check: the permission is
 * inferred from the command being invoked.
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
  traecn_capabilities: READ_PERMISSION,
  traecn_command_set: READ_PERMISSION,
  check_status: READ_PERMISSION,
  check_dialog: READ_PERMISSION,
  check_queue: READ_PERMISSION,
  get_settings: READ_PERMISSION,
  preflight: READ_PERMISSION,
  plan_operation: READ_PERMISSION,
  switch_model: WRITE_PERMISSION,
  switch_mode: WRITE_PERMISSION,
  new_chat: WRITE_PERMISSION,
  list_solo_chats: READ_PERMISSION,
  switch_solo_chat: WRITE_PERMISSION,
  cleanup_foreign_solo_queue: DELEGATE_PERMISSION,
  cleanup_queue_watch_status: READ_PERMISSION,
  long_queue_proof_status: READ_PERMISSION,
  long_queue_proof_start: DELEGATE_PERMISSION,
  long_queue_proof_cancel: DELEGATE_PERMISSION,
  submit_solo_chat_task: DELEGATE_PERMISSION,
  poll_task: READ_PERMISSION,
  wait_task: READ_PERMISSION,
  adopt_current_task: DELEGATE_PERMISSION,
  cancel_task: DELEGATE_PERMISSION,
  stop_generation: DELEGATE_PERMISSION,
  dismiss_dialog: DELEGATE_PERMISSION,
  restart_trae_debug: DELEGATE_PERMISSION,
  review_gate_status: READ_PERMISSION,
  resolve_review_gate: DELEGATE_PERMISSION,
  run_task: DELEGATE_PERMISSION,
  queue_task: DELEGATE_PERMISSION,
  vibe_workflow: DELEGATE_PERMISSION,
  review_code: DELEGATE_PERMISSION,
  set_setting: ADMIN_PERMISSION,
  approve_dialog: DELEGATE_PERMISSION,
  open_project: DELEGATE_PERMISSION,
  // traecn_command has dynamic permission resolution (see resolveCommandPermission).
});

// Commands that escalate to admin permission; everything else with side effects
// is "delegate" or below.
const ADMIN_COMMANDS = new Set([
  // placeholder for future admin-level commands
]);

const READ_COMMANDS = new Set([
  'batch_status',
  'dialog_status',
  'cleanup_queue_watch_status',
  'long_queue_proof_status',
  'queue_status',
  'review_gate_status',
  'settings_read',
  'settings_read_all',
  'task_status'
]);

function resolveCommandPermission(command) {
  if (typeof command !== 'string' || !command) return READ_PERMISSION;
  if (ADMIN_COMMANDS.has(command)) return ADMIN_PERMISSION;
  if (READ_COMMANDS.has(command)) return READ_PERMISSION;
  // Conservative default: assume side effect -> require delegate.
  // Read-only commands start with `get_`, `list_`, `check_`, `read_`.
  if (/^(get|list|check|read|preflight|status|describe)/i.test(command)) return READ_PERMISSION;
  return DELEGATE_PERMISSION;
}

function requiredPermissionFor(toolName, args = {}) {
  if (toolName === 'traecn_command') {
    if (args && args.command === 'wait_task') {
      return args.params && args.params.autoApproveDialog ? DELEGATE_PERMISSION : READ_PERMISSION;
    }
    return resolveCommandPermission(args && args.command);
  }
  if (toolName === 'wait_task' && args && args.autoApproveDialog) {
    return DELEGATE_PERMISSION;
  }
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
  resolveCommandPermission,
  authorizeTool,
  hasPermission,
  assertValidPermission
};
