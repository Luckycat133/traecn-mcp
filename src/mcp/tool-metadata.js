'use strict';

const { RAW_MCP_TOOLS } = require('./tools');

const DEFAULT_MCP_TOOL_PROFILE = 'default';

const TOOL_METADATA = Object.freeze({
  traecn_send_message: { layer: 'task', risk: 'delegate' },
  traecn_get_task: { layer: 'task', risk: 'read' },
  traecn_cancel_task: { layer: 'task', risk: 'delegate', destructive: true },
  traecn_stop_generation: { layer: 'task', risk: 'delegate', destructive: true },
  traecn_open_workspace: { layer: 'context', risk: 'delegate' },
  traecn_list_models: { layer: 'context', risk: 'read' },
  traecn_select_model: { layer: 'context', risk: 'write' },
  traecn_select_mode: { layer: 'context', risk: 'write' },
  traecn_list_setting_sections: { layer: 'settings', risk: 'read' },
  traecn_list_settings: { layer: 'settings', risk: 'read' },
  traecn_list_setting_options: { layer: 'settings', risk: 'read' },
  traecn_set_setting_toggle: { layer: 'settings', risk: 'write' },
  traecn_select_setting_option: { layer: 'settings', risk: 'write' },
  traecn_set_setting_text: { layer: 'settings', risk: 'write' },
  traecn_list_conversations: { layer: 'conversation', risk: 'read' },
  traecn_create_conversation: { layer: 'conversation', risk: 'write' },
  traecn_select_conversation: { layer: 'conversation', risk: 'write' },
  traecn_delete_conversation: { layer: 'conversation', risk: 'delegate', destructive: true },
  traecn_answer_question: { layer: 'interaction', risk: 'delegate' },
  traecn_decide_approval: { layer: 'interaction', risk: 'delegate', destructive: true }
});

const TOOL_ANNOTATIONS = Object.freeze({
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  delegate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
});

const DESTRUCTIVE_MCP_TOOLS = new Set(
  Object.entries(TOOL_METADATA)
    .filter(([, metadata]) => metadata.destructive === true)
    .map(([name]) => name)
);

function getMcpToolMetadata(toolName) {
  return TOOL_METADATA[toolName] || { layer: 'misc', risk: 'delegate' };
}

function decorateTool(tool) {
  const metadata = getMcpToolMetadata(tool.name);
  return Object.freeze({
    ...tool,
    annotations: {
      ...(TOOL_ANNOTATIONS[metadata.risk] || TOOL_ANNOTATIONS.delegate),
      destructiveHint: DESTRUCTIVE_MCP_TOOLS.has(tool.name)
    }
  });
}

const MCP_TOOLS = Object.freeze(RAW_MCP_TOOLS.map(decorateTool));
const MCP_TOOL_PROFILES = Object.freeze({ default: Object.freeze(MCP_TOOLS.map(tool => tool.name)) });
const MCP_TOOL_PROFILE_DESCRIPTIONS = Object.freeze({
  default: 'Focused Agent operations. Gateway-owned mechanics are intentionally not exposed as tools.'
});

function normalizeMcpToolProfile() {
  return DEFAULT_MCP_TOOL_PROFILE;
}

function getMcpToolsForProfile() {
  return MCP_TOOLS;
}

function getMcpToolProfileSummary() {
  return {
    default: {
      default: true,
      count: MCP_TOOLS.length,
      description: MCP_TOOL_PROFILE_DESCRIPTIONS.default,
      tools: MCP_TOOLS.map(tool => tool.name)
    }
  };
}

function envToolProfile() {
  return DEFAULT_MCP_TOOL_PROFILE;
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
