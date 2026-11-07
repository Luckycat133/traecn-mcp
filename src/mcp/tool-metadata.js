'use strict';

const { RAW_MCP_TOOLS } = require('./tools');
const { assertMcpContract } = require('./contract');
const { getMcpToolOutputSchema } = require('./output-schemas');

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

// Annotations describe characterized behavior:
// - reads are read-only and idempotent;
// - selections with proven same-state no-ops (model.js `alreadySelected`,
//   mode-detection.js `alreadyInMode`, settings-driver "already in desired
//   state") keep idempotentHint on their write class;
// - every tool except send_message is confined to the local TraeCN instance
//   and its gateway, so openWorldHint stays false there; delegated work may
//   reach beyond that closed state.
const TOOL_ANNOTATIONS = Object.freeze({
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  delegate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
});

const TOOL_ANNOTATION_OVERRIDES = Object.freeze({
  traecn_send_message: { openWorldHint: true },
  traecn_select_model: { idempotentHint: true },
  traecn_select_mode: { idempotentHint: true },
  traecn_set_setting_toggle: { idempotentHint: true }
});

const TOOL_TITLES = Object.freeze({
  traecn_send_message: 'Send TraeCN Task',
  traecn_get_task: 'Get TraeCN Task',
  traecn_cancel_task: 'Cancel TraeCN Task',
  traecn_stop_generation: 'Stop Visible Generation',
  traecn_open_workspace: 'Open TraeCN Workspace',
  traecn_list_models: 'List TraeCN Models',
  traecn_select_model: 'Select TraeCN Model',
  traecn_select_mode: 'Select TraeCN Mode',
  traecn_list_setting_sections: 'List TraeCN Settings Sections',
  traecn_list_settings: 'List TraeCN Section Settings',
  traecn_list_setting_options: 'List TraeCN Setting Options',
  traecn_set_setting_toggle: 'Set TraeCN Setting Toggle',
  traecn_select_setting_option: 'Select TraeCN Setting Option',
  traecn_set_setting_text: 'Set TraeCN Setting Text',
  traecn_list_conversations: 'List TraeCN Conversations',
  traecn_create_conversation: 'Create TraeCN Conversation',
  traecn_select_conversation: 'Select TraeCN Conversation',
  traecn_delete_conversation: 'Delete TraeCN Conversation',
  traecn_answer_question: 'Answer TraeCN Question',
  traecn_decide_approval: 'Decide TraeCN Approval'
});

// Only send_message creates durable asynchronous work; the Tasks extension
// negotiates whether the host wants MCP task handles for it. Every other
// contract-v5 tool completes within its call.
const TOOL_TASK_SUPPORT = Object.freeze({
  traecn_send_message: 'optional'
});

function getMcpToolTaskSupport(toolName) {
  return TOOL_TASK_SUPPORT[toolName] || 'forbidden';
}

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
  const annotations = {
    ...(TOOL_ANNOTATIONS[metadata.risk] || TOOL_ANNOTATIONS.delegate),
    ...(TOOL_ANNOTATION_OVERRIDES[tool.name] || {}),
    destructiveHint: DESTRUCTIVE_MCP_TOOLS.has(tool.name)
  };
  return Object.freeze({
    ...tool,
    title: TOOL_TITLES[tool.name],
    outputSchema: getMcpToolOutputSchema(tool.name),
    annotations,
    execution: Object.freeze({ taskSupport: getMcpToolTaskSupport(tool.name) })
  });
}

const MCP_TOOLS = Object.freeze(assertMcpContract(RAW_MCP_TOOLS.map(decorateTool)));

module.exports = {
  MCP_TOOLS,
  TOOL_METADATA,
  TOOL_ANNOTATIONS,
  TOOL_ANNOTATION_OVERRIDES,
  TOOL_TITLES,
  TOOL_TASK_SUPPORT,
  DESTRUCTIVE_MCP_TOOLS,
  decorateTool,
  getMcpToolMetadata,
  getMcpToolTaskSupport
};
