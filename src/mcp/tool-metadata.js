'use strict';

/**
 * MCP 工具元数据 — 工具分层、风险级别、profile 管理和注解装饰。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const { RAW_MCP_TOOLS } = require('./tools');

const DEFAULT_MCP_TOOL_PROFILE = 'public';

const TOOL_METADATA = Object.freeze({
  traecn_get_capabilities: { layer: 'discovery', profile: 'public', risk: 'read' },
  traecn_list_commands: { layer: 'discovery', profile: 'public', risk: 'read' },
  traecn_run_command: { layer: 'escape-hatch', profile: 'public', risk: 'dynamic' },
  traecn_plan_operation: { layer: 'planning', profile: 'public', risk: 'read' },
  traecn_preflight: { layer: 'planning', profile: 'public', risk: 'read' },
  traecn_run_task: { layer: 'task', profile: 'public', risk: 'delegate' },
  traecn_queue_task: { layer: 'task', profile: 'public', risk: 'delegate' },
  traecn_poll_task: { layer: 'task', profile: 'public', risk: 'read' },
  traecn_wait_task: { layer: 'task', profile: 'public', risk: 'read-or-delegate' },
  traecn_resolve_task_review: { layer: 'task-review', profile: 'public', risk: 'delegate' },
  traecn_cancel_task: { layer: 'task', profile: 'public', risk: 'delegate', destructive: true },
  traecn_review_code: { layer: 'review', profile: 'public', risk: 'delegate' },
  traecn_switch_model: { layer: 'control', profile: 'public', risk: 'write' },
  traecn_switch_mode: { layer: 'control', profile: 'public', risk: 'write' },
  traecn_create_chat: { layer: 'control', profile: 'public', risk: 'write' },
  traecn_get_settings: { layer: 'settings', profile: 'public', risk: 'read' },
  traecn_set_setting: { layer: 'settings', profile: 'public', risk: 'admin' },
  traecn_respond_dialog: { layer: 'dialog', profile: 'public', risk: 'delegate' },
  traecn_get_dialog_status: { layer: 'dialog', profile: 'public', risk: 'read' },
  traecn_open_project: { layer: 'control', profile: 'public', risk: 'delegate' },
  traecn_run_unattended_workflow: { layer: 'workflow', profile: 'public', risk: 'delegate' },

  traecn_adopt_current_task: { layer: 'recovery', profile: 'ops', risk: 'delegate' },
  traecn_stop_generation: { layer: 'recovery', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_get_review_gate_status: { layer: 'recovery', profile: 'ops', risk: 'read' },
  traecn_resolve_review_gate: { layer: 'recovery', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_restart_debug_session: { layer: 'recovery', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_list_solo_chats: { layer: 'solo', profile: 'ops', risk: 'read' },
  traecn_switch_solo_chat: { layer: 'solo', profile: 'ops', risk: 'write' },
  traecn_cleanup_queue_probe_chats: { layer: 'cleanup', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_get_cleanup_watch_status: { layer: 'cleanup', profile: 'ops', risk: 'read' },
  traecn_start_long_queue_proof: { layer: 'acceptance', profile: 'ops', risk: 'delegate' },
  traecn_get_long_queue_proof_status: { layer: 'acceptance', profile: 'ops', risk: 'read' },
  traecn_cancel_long_queue_proof: { layer: 'acceptance', profile: 'ops', risk: 'delegate', destructive: true },

  traecn_get_status: { layer: 'diagnostics', profile: 'full', risk: 'read', alternative: 'traecn_preflight' },
  traecn_get_queue_status: { layer: 'diagnostics', profile: 'full', risk: 'read', alternative: 'traecn_preflight' },
  traecn_dismiss_dialog: { layer: 'dialog', profile: 'full', risk: 'delegate', destructive: true, alternative: 'traecn_respond_dialog' },
  traecn_submit_solo_task: { layer: 'solo', profile: 'full', risk: 'delegate', alternative: 'traecn_queue_task' }
});

const TOOL_ANNOTATIONS = Object.freeze({
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  delegate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  admin: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  dynamic: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  'read-or-delegate': { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
});

const PUBLIC_MCP_TOOL_NAMES = Object.freeze(
  Object.entries(TOOL_METADATA)
    .filter(([, meta]) => meta.profile === 'public')
    .map(([name]) => name)
);

const OPS_MCP_TOOL_NAMES = Object.freeze(
  Object.entries(TOOL_METADATA)
    .filter(([, meta]) => meta.profile === 'public' || meta.profile === 'ops')
    .map(([name]) => name)
);

const DESTRUCTIVE_MCP_TOOLS = new Set(
  Object.entries(TOOL_METADATA)
    .filter(([, meta]) => meta.destructive === true)
    .map(([name]) => name)
);

function decorateTool(tool) {
  const metadata = TOOL_METADATA[tool.name] || { layer: 'misc', profile: 'full', risk: 'dynamic' };
  const annotations = {
    ...(TOOL_ANNOTATIONS[metadata.risk] || TOOL_ANNOTATIONS.dynamic),
    destructiveHint: DESTRUCTIVE_MCP_TOOLS.has(tool.name)
  };
  return Object.freeze({
    ...tool,
    annotations
  });
}

const MCP_TOOLS = Object.freeze(RAW_MCP_TOOLS.map(decorateTool));

const FULL_MCP_TOOL_NAMES = Object.freeze(MCP_TOOLS.map(tool => tool.name));

const MCP_TOOL_PROFILES = Object.freeze({
  public: Object.freeze(PUBLIC_MCP_TOOL_NAMES.slice()),
  ops: Object.freeze(OPS_MCP_TOOL_NAMES.slice()),
  full: FULL_MCP_TOOL_NAMES
});

const MCP_TOOL_PROFILE_DESCRIPTIONS = Object.freeze({
  public: 'Default profile for general MCP clients. Keeps high-signal task, review, settings, dialog, and workflow tools visible.',
  ops: 'Operational profile for recovery, cleanup, Solo conversation management, and long-queue proof workflows.',
  full: 'Complete explicit tool surface, including diagnostics and compatibility shortcuts that public clients can usually reach through traecn_preflight or traecn_run_command.'
});

function normalizeMcpToolProfile(profile) {
  const normalized = String(profile || DEFAULT_MCP_TOOL_PROFILE).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MCP_TOOL_PROFILES, normalized) ? normalized : DEFAULT_MCP_TOOL_PROFILE;
}

function getMcpToolsForProfile(profile = DEFAULT_MCP_TOOL_PROFILE) {
  const normalized = normalizeMcpToolProfile(profile);
  const names = new Set(MCP_TOOL_PROFILES[normalized]);
  return MCP_TOOLS.filter(tool => names.has(tool.name));
}

function getMcpToolMetadata(toolName) {
  return TOOL_METADATA[toolName] || { layer: 'misc', profile: 'full', risk: 'dynamic' };
}

function getMcpToolProfileSummary() {
  return Object.fromEntries(Object.entries(MCP_TOOL_PROFILES).map(([name, tools]) => [
    name,
    {
      default: name === DEFAULT_MCP_TOOL_PROFILE,
      count: tools.length,
      description: MCP_TOOL_PROFILE_DESCRIPTIONS[name],
      tools: tools.slice()
    }
  ]));
}

function envToolProfile() {
  return normalizeMcpToolProfile(process.env.TRAECN_MCP_TOOL_PROFILE);
}

module.exports = {
  DEFAULT_MCP_TOOL_PROFILE,
  MCP_TOOL_PROFILES,
  MCP_TOOL_PROFILE_DESCRIPTIONS,
  MCP_TOOLS,
  TOOL_METADATA,
  TOOL_ANNOTATIONS,
  DESTRUCTIVE_MCP_TOOLS,
  decorateTool,
  normalizeMcpToolProfile,
  getMcpToolsForProfile,
  getMcpToolMetadata,
  getMcpToolProfileSummary,
  envToolProfile
};
